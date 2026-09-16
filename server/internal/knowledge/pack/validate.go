package pack

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

var identifier = regexp.MustCompile(`^[\p{L}\p{N}_.:/@-]+$`)
var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var commitPattern = regexp.MustCompile(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`)

func stringLength(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r > 0xffff {
			n++
		}
	}
	return n // JavaScript string lengths count UTF-16 code units.
}
func validID(s string) bool {
	return utf8.ValidString(s) && stringLength(s) <= 256 && identifier.MatchString(s)
}
func validDigest(s string) bool           { return digestPattern.MatchString(s) }
func validRef(r ObjectRef) bool           { return validID(r.ObjectID) && validID(r.ObjectVersion) }
func in(s string, choices ...string) bool { return slices.Contains(choices, s) }
func bounded(n, min, max int) bool        { return n >= min && n <= max }

type sourceRef struct{ id, version string }

// ValidatePayload enforces the same schema, evidence closure, and relation
// direction rules as src/knowledge-producer/schema.ts.
func ValidatePayload(p Payload) error {
	if !validID(p.ProjectID) || p.Status != "preview" {
		return errors.New("invalid project ID or package state")
	}
	if !bounded(len(p.Sources), 1, 200) || !bounded(len(p.SourcePolicyRefs), 1, 200) ||
		!bounded(len(p.Objects), 1, 10000) || !bounded(len(p.Evidence), 1, 20000) ||
		p.Relations == nil || len(p.Relations) > 20000 || p.DefaultObjectVersions == nil ||
		p.Coverage.Warnings == nil || len(p.Coverage.Warnings) > 2000 {
		return errors.New("invalid package collection size or missing collection")
	}
	sources := make(map[sourceRef]SourceSnapshot, len(p.Sources))
	lineOffsets := make(map[sourceRef][]int, len(p.Sources))
	policies := make(map[string]bool)
	for _, source := range p.Sources {
		if !validID(source.SourceID) || !commitPattern.MatchString(source.SourceVersion) ||
			!utf8.ValidString(source.Path) || source.Path == "" || !in(source.Kind, "requirements", "meeting", "transcript", "code") ||
			!validID(source.PolicyRef) || !utf8.ValidString(source.Content) || len(source.Content) > MaxSourceBytes {
			return errors.New("invalid source snapshot")
		}
		key := sourceRef{source.SourceID, source.SourceVersion}
		if _, exists := sources[key]; exists {
			return errors.New("duplicate source version")
		}
		if !validDigest(source.ContentHash) || hash([]byte(source.Content)) != source.ContentHash {
			return errors.New("source hash mismatch")
		}
		sources[key] = source
		// Index each source version once. An evidence quote can then be checked
		// by slicing the original text, without splitting or joining it again.
		offsets := make([]int, 1, strings.Count(source.Content, "\n")+1)
		for index := 0; index < len(source.Content); index++ {
			if source.Content[index] == '\n' {
				offsets = append(offsets, index+1)
			}
		}
		lineOffsets[key] = offsets
		policies[source.PolicyRef] = true
	}
	if len(policies) != len(p.SourcePolicyRefs) {
		return errors.New("source policy dependencies must exactly cover every source")
	}
	for _, policy := range p.SourcePolicyRefs {
		if !validID(policy) || !policies[policy] {
			return errors.New("source policy dependencies must exactly cover every source")
		}
		delete(policies, policy)
	}
	evidence := make(map[string]Evidence, len(p.Evidence))
	for _, item := range p.Evidence {
		if !validID(item.EvidenceID) || !validID(item.SourceID) || !commitPattern.MatchString(item.SourceVersion) ||
			!validDigest(item.SourceHash) || !utf8.ValidString(item.Quote) || item.LineStart < 1 || item.LineEnd < item.LineStart {
			return errors.New("invalid evidence")
		}
		if _, exists := evidence[item.EvidenceID]; exists {
			return errors.New("duplicate evidence ID")
		}
		source, exists := sources[sourceRef{item.SourceID, item.SourceVersion}]
		if !exists || source.ContentHash != item.SourceHash {
			return errors.New("evidence source is missing or changed")
		}
		offsets := lineOffsets[sourceRef{item.SourceID, item.SourceVersion}]
		if item.LineEnd > len(offsets) {
			return errors.New("evidence does not match its source lines")
		}
		endOffset := len(source.Content)
		if item.LineEnd < len(offsets) {
			endOffset = offsets[item.LineEnd] - 1
		}
		if source.Content[offsets[item.LineStart-1]:endOffset] != item.Quote {
			return errors.New("evidence does not match its source lines")
		}
		if (item.TimeStartMS == nil) != (item.TimeEndMS == nil) ||
			(item.TimeStartMS != nil && (*item.TimeStartMS < 0 || *item.TimeEndMS < *item.TimeStartMS)) {
			return errors.New("invalid evidence time range")
		}
		evidence[item.EvidenceID] = item
	}
	checkEvidence := func(refs []string) error {
		if !bounded(len(refs), 1, 100) {
			return errors.New("invalid evidence reference count")
		}
		for _, ref := range refs {
			if _, exists := evidence[ref]; !validID(ref) || !exists {
				return errors.New("missing evidence reference")
			}
		}
		return nil
	}
	objects := make(map[ObjectRef]Object, len(p.Objects))
	for _, object := range p.Objects {
		if !validRef(object.Ref()) || !in(object.Type, "BusinessConcept", "RequirementItem", "Meeting", "Statement", "Decision", "CodeEntity", "SourceDocument") ||
			!utf8.ValidString(object.Title) || !bounded(stringLength(object.Title), 1, 1024) || !utf8.ValidString(object.Content) {
			return errors.New("invalid object")
		}
		if _, exists := objects[object.Ref()]; exists {
			return errors.New("duplicate object version")
		}
		if !validDigest(object.ContentHash) || hash([]byte(object.Content)) != object.ContentHash {
			return errors.New("object hash mismatch")
		}
		if err := checkEvidence(object.EvidenceRefs); err != nil {
			return err
		}
		objects[object.Ref()] = object
	}
	relationIDs := make(map[string]bool)
	supersedes := make(map[ObjectRef][]ObjectRef)
	indegree := make(map[ObjectRef]int)
	for _, relation := range p.Relations {
		if !validID(relation.RelationID) || !validRef(relation.From) || !validRef(relation.To) ||
			!in(relation.Origin, "explicit_reference", "static_extraction", "human_assertion", "ai_inference") ||
			relation.ReviewState != "candidate" || relation.Applicability != "unknown" {
			return errors.New("invalid relation metadata")
		}
		if relationIDs[relation.RelationID] {
			return errors.New("duplicate relation ID")
		}
		relationIDs[relation.RelationID] = true
		from, fromExists := objects[relation.From]
		to, toExists := objects[relation.To]
		if !fromExists || !toExists {
			return errors.New("relation endpoint is not included in this package")
		}
		if err := checkEvidence(relation.EvidenceRefs); err != nil {
			return err
		}
		if !validRelationTypes(relation.Type, from.Type, to.Type) {
			return errors.New("invalid relation endpoint types")
		}
		if relation.Type == "SUPERSEDES" {
			supersedes[relation.From] = append(supersedes[relation.From], relation.To)
			if _, exists := indegree[relation.From]; !exists {
				indegree[relation.From] = 0
			}
			indegree[relation.To]++
		}
	}
	queue := make([]ObjectRef, 0, len(indegree))
	for ref, degree := range indegree {
		if degree == 0 {
			queue = append(queue, ref)
		}
	}
	for i := 0; i < len(queue); i++ {
		for _, to := range supersedes[queue[i]] {
			indegree[to]--
			if indegree[to] == 0 {
				queue = append(queue, to)
			}
		}
	}
	if len(queue) != len(indegree) {
		return errors.New("cyclic SUPERSEDES relation")
	}
	for objectID, version := range p.DefaultObjectVersions {
		if _, exists := objects[ObjectRef{objectID, version}]; !validID(version) || !exists {
			return errors.New("default object version is missing")
		}
	}
	for _, warning := range p.Coverage.Warnings {
		if !utf8.ValidString(warning) {
			return fmt.Errorf("invalid coverage warning")
		}
	}
	return nil
}

func validRelationTypes(kind, from, to string) bool {
	switch kind {
	case "ABOUT":
		return (from == "RequirementItem" && to == "BusinessConcept") || (from == "Statement" && in(to, "RequirementItem", "BusinessConcept"))
	case "HAS_STATEMENT":
		return from == "Meeting" && to == "Statement"
	case "SUPPORTS", "CHALLENGES":
		return from == "Statement" && in(to, "Decision", "RequirementItem")
	case "ADDRESSES":
		return from == "Decision" && to == "RequirementItem"
	case "SPECIFIES":
		return from == "SourceDocument" && to == "RequirementItem"
	case "IMPLEMENTS":
		return from == "CodeEntity" && to == "RequirementItem"
	case "DEPENDS_ON":
		return from == "CodeEntity" && to == "CodeEntity"
	case "SUPERSEDES":
		return from == to && in(from, "RequirementItem", "Decision")
	default:
		return false
	}
}
