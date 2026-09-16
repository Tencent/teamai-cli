// knowledge-pack is a local development preview tool, not an enterprise access
// gateway. The caller already possesses the file and explicitly acknowledges it.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/Tencent/teamai-cli/server/internal/knowledge/pack"
)

func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr)) }

func run(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("knowledge-pack", flag.ContinueOnError)
	flags.SetOutput(stderr)
	file := flags.String("pack", "", "Local knowledge package file")
	localPreview := flags.Bool("local-preview", false, "Acknowledge development preview of a local file already in your possession")
	query := flags.String("query", "", "Search all keywords in this package")
	object := flags.String("object", "", "Read this exact object ID; requires --version")
	version := flags.String("version", "", "Exact object version; no default or latest fallback")
	relations := flags.String("relations", "", "Read object relations: incoming, outgoing, or both")
	relationType := flags.String("relation-type", "", "Optional exact relation type filter with --relations")
	trace := flags.String("trace", "", "Trace this exact object ID; requires --version")
	depth := flags.Int("depth", 2, "Trace depth from 0 through 3")
	maxNodes := flags.Int("max-nodes", pack.MaxTraceNodes, "Trace node limit from 1 through 100")
	maxTextBytes := flags.Int("max-text-bytes", pack.DefaultTraceTextBytes, "Trace title/content/quote byte limit from 1 through 1048576")
	if err := flags.Parse(args); err != nil {
		if err == flag.ErrHelp {
			return 0
		}
		return 2
	}
	provided := make(map[string]bool)
	flags.Visit(func(f *flag.Flag) { provided[f.Name] = true })
	fail := func(message string) int { fmt.Fprintln(stderr, "Error:", message); return 2 }
	if !*localPreview {
		return fail("--local-preview is required; this tool is for development preview only")
	}
	if *file == "" || flags.NArg() != 0 {
		return fail("--pack must name one local package file; positional arguments are not accepted")
	}
	modes := 0
	for _, name := range []string{"query", "object", "trace"} {
		if provided[name] {
			modes++
		}
	}
	if modes > 1 {
		return fail("choose only one of --query, --object, or --trace")
	}
	if (provided["object"] || provided["trace"]) && *version == "" {
		return fail("an exact --version is required")
	}
	if provided["version"] && !provided["object"] && !provided["trace"] {
		return fail("--version requires --object or --trace")
	}
	if provided["relations"] && !provided["object"] {
		return fail("--relations requires --object")
	}
	if provided["relation-type"] && !provided["relations"] {
		return fail("--relation-type requires --relations")
	}
	if (provided["depth"] || provided["max-nodes"] || provided["max-text-bytes"]) && !provided["trace"] {
		return fail("trace bounds require --trace")
	}
	if provided["relations"] && *relations != "incoming" && *relations != "outgoing" && *relations != "both" {
		return fail("--relations must be incoming, outgoing, or both")
	}
	if provided["trace"] && (*maxNodes < 1 || *maxNodes > pack.MaxTraceNodes || *depth < 0 || *depth > pack.MaxTraceDepth || *maxTextBytes < 1 || *maxTextBytes > pack.MaxTraceTextBytes) {
		return fail("trace bounds are outside the permitted range")
	}
	fmt.Fprintln(stderr, "Warning: development preview only. This reads a local file already in your possession; it does not enforce enterprise identity, authorization, or revocation.")
	input, err := os.Open(*file)
	if err != nil {
		return fail(err.Error())
	}
	defer input.Close()
	archive, err := pack.Read(input)
	if err != nil {
		return fail(err.Error())
	}
	// Only this explicitly acknowledged local CLI supplies an always-allow
	// adapter. A host application must supply its own live policy authority.
	engine, err := pack.NewEngine(archive.Payload, pack.AuthorizerFunc(func(context.Context, any, string) error { return nil }))
	if err != nil {
		return fail(err.Error())
	}
	var output any
	ctx := context.Background()
	switch {
	case provided["query"]:
		output, err = engine.Search(ctx, nil, *query)
	case provided["object"]:
		ref := pack.ObjectRef{ObjectID: *object, ObjectVersion: *version}
		if provided["relations"] {
			output, err = engine.Relations(ctx, nil, ref, pack.Direction(*relations), *relationType)
		} else {
			output, err = engine.GetObject(ctx, nil, ref)
		}
	case provided["trace"]:
		output, err = engine.Trace(ctx, nil, pack.ObjectRef{ObjectID: *trace, ObjectVersion: *version}, pack.TraceOptions{MaxDepth: *depth, MaxNodes: *maxNodes, MaxTextBytes: *maxTextBytes})
	default:
		output = struct {
			SchemaVersion string `json:"schema_version"`
			PackageHash   string `json:"package_hash"`
			State         string `json:"state"`
			Sources       int    `json:"sources"`
			Objects       int    `json:"objects"`
			Relations     int    `json:"relations"`
			Evidence      int    `json:"evidence"`
		}{archive.SchemaVersion, archive.PackageHash, "preview", len(archive.Payload.Sources), len(archive.Payload.Objects), len(archive.Payload.Relations), len(archive.Payload.Evidence)}
	}
	if err != nil {
		return fail(err.Error())
	}
	encoder := json.NewEncoder(stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(output); err != nil {
		return fail(err.Error())
	}
	return 0
}
