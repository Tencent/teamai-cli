package pack

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
	"unicode/utf8"
)

// Read hashes the exact embedded payload bytes, never a reserialized payload.
// The entire input, including trailing whitespace, is limited to MaxPackBytes.
func Read(r io.Reader) (*Pack, error) {
	data, err := io.ReadAll(io.LimitReader(r, MaxPackBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read package: %w", err)
	}
	if len(data) > MaxPackBytes {
		return nil, errors.New("package exceeds 16 MiB limit")
	}
	if !utf8.Valid(data) {
		return nil, errors.New("package contains invalid UTF-8")
	}
	if err := checkJSON(data); err != nil {
		return nil, err
	}
	var envelope struct {
		SchemaVersion string          `json:"schema_version"`
		PackageHash   string          `json:"package_hash"`
		Payload       json.RawMessage `json:"payload"`
	}
	if err := strictDecode(data, &envelope); err != nil {
		return nil, fmt.Errorf("invalid envelope: %w", err)
	}
	if envelope.SchemaVersion != SchemaVersion {
		return nil, errors.New("unsupported package schema")
	}
	if !validDigest(envelope.PackageHash) || hash(envelope.Payload) != envelope.PackageHash {
		return nil, errors.New("package hash mismatch")
	}
	var payload Payload
	if err := strictDecode(envelope.Payload, &payload); err != nil {
		return nil, fmt.Errorf("invalid payload: %w", err)
	}
	if err := ValidatePayload(payload); err != nil {
		return nil, err
	}
	return &Pack{SchemaVersion: envelope.SchemaVersion, PackageHash: envelope.PackageHash, Payload: payload}, nil
}

func hash(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

// checkJSON catches duplicate keys at every level before decoding can erase them.
func checkJSON(data []byte) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var value func(int) error
	value = func(depth int) error {
		if depth > 64 {
			return errors.New("JSON nesting exceeds limit")
		}
		token, err := d.Token()
		if err != nil {
			return fmt.Errorf("invalid JSON: %w", err)
		}
		delim, compound := token.(json.Delim)
		if !compound {
			return nil
		}
		switch delim {
		case '{':
			seen := make(map[string]bool)
			for d.More() {
				key, err := d.Token()
				if err != nil {
					return err
				}
				name, ok := key.(string)
				if !ok {
					return errors.New("invalid JSON object key")
				}
				if seen[name] {
					return errors.New("duplicate JSON object key")
				}
				seen[name] = true
				if err := value(depth + 1); err != nil {
					return err
				}
			}
		case '[':
			for d.More() {
				if err := value(depth + 1); err != nil {
					return err
				}
			}
		default:
			return errors.New("unexpected JSON delimiter")
		}
		end, err := d.Token()
		if err != nil {
			return err
		}
		if (delim == '{' && end != json.Delim('}')) || (delim == '[' && end != json.Delim(']')) {
			return errors.New("invalid JSON closing delimiter")
		}
		return nil
	}
	if err := value(0); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return errors.New("trailing JSON data")
	}
	return nil
}

func strictDecode(data []byte, destination any) error {
	if err := checkShape(data, reflect.TypeOf(destination).Elem()); err != nil {
		return err
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	return d.Decode(destination)
}

var rawMessageType = reflect.TypeOf(json.RawMessage{})

// Go's JSON decoder otherwise accepts null, absent fields, and case-insensitive
// struct field names. All three differ from the shared strict TypeScript schema.
func checkShape(data []byte, typ reflect.Type) error {
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return errors.New("null is not permitted")
	}
	if typ == rawMessageType {
		return nil
	}
	if typ.Kind() == reflect.Pointer {
		return checkShape(data, typ.Elem())
	}
	switch typ.Kind() {
	case reflect.Struct:
		var members map[string]json.RawMessage
		if err := json.Unmarshal(data, &members); err != nil {
			return err
		}
		known := make(map[string]bool, typ.NumField())
		for i := 0; i < typ.NumField(); i++ {
			field := typ.Field(i)
			tag := strings.Split(field.Tag.Get("json"), ",")
			name := tag[0]
			known[name] = true
			raw, exists := members[name]
			if !exists {
				if len(tag) > 1 && tag[1] == "omitempty" {
					continue
				}
				return fmt.Errorf("missing required field %q", name)
			}
			if err := checkShape(raw, field.Type); err != nil {
				return fmt.Errorf("field %q: %w", name, err)
			}
		}
		for name := range members {
			if !known[name] {
				return fmt.Errorf("unknown field %q", name)
			}
		}
	case reflect.Slice:
		var elements []json.RawMessage
		if err := json.Unmarshal(data, &elements); err != nil {
			return err
		}
		for _, element := range elements {
			if err := checkShape(element, typ.Elem()); err != nil {
				return err
			}
		}
	case reflect.Map:
		var members map[string]json.RawMessage
		if err := json.Unmarshal(data, &members); err != nil {
			return err
		}
		for _, member := range members {
			if err := checkShape(member, typ.Elem()); err != nil {
				return err
			}
		}
	}
	return nil
}
