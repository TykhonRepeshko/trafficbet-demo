package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestCrossingRulesFiniteLineDirectionAndTimeBoundaries(t *testing.T) {
	rule := preparationDefinition()
	start := time.Unix(1700000000, 0)
	end := start.Add(time.Minute)
	before, after := CountingPoint{.5, .4}, CountingPoint{.5, .6}
	c, ok := crossingCandidate(rule, before, after, start.Add(-time.Second), start.Add(time.Second), start, end, "car")
	if !ok || !c.At.Equal(start) || c.Direction != "A_to_B" {
		t.Fatal("inclusive start crossing rejected", c, ok)
	}
	if _, ok = crossingCandidate(rule, before, after, end.Add(-time.Second), end.Add(time.Second), start, end, "car"); ok {
		t.Fatal("exclusive end crossing accepted")
	}
	if _, ok = crossingCandidate(rule, CountingPoint{.95, .4}, CountingPoint{.95, .6}, start, start.Add(time.Second), start, end, "car"); ok {
		t.Fatal("extension beyond finite line counted")
	}
	if _, ok = crossingCandidate(rule, before, CountingPoint{.5, .5}, start, start.Add(time.Second), start, end, "car"); ok {
		t.Fatal("line touch counted")
	}
	if _, ok = crossingCandidate(rule, before, after, start, start.Add(time.Second), start, end, "bus"); ok {
		t.Fatal("excluded class counted")
	}
	rule.Directions = []string{"B_to_A"}
	if _, ok = crossingCandidate(rule, before, after, start, start.Add(time.Second), start, end, "car"); ok {
		t.Fatal("excluded direction counted")
	}
}
func TestManualIntervalsRequireBoundedDistinctCrossings(t *testing.T) {
	v := ManualInterval{ProfileID: 1, ClipSHA256: strings.Repeat("a", 64), Split: "test", DurationMS: 10000, Condition: "unknown", TimingEvidence: "Capture UTC is unknown in this synthetic unit fixture.", Note: "One synthetic crossing used only for contract validation.", Crossings: []ManualCrossing{{Track: "one", OffsetMS: 100, Class: "car", Direction: "A_to_B"}}}
	if !validManualInterval(v) {
		t.Fatal("valid manual annotation rejected")
	}
	v.Crossings = append(v.Crossings, v.Crossings[0])
	if validManualInterval(v) {
		t.Fatal("duplicate vehicle track counted")
	}
	v.Crossings = v.Crossings[:1]
	v.Crossings[0].OffsetMS = v.DurationMS
	if validManualInterval(v) {
		t.Fatal("exclusive end event accepted")
	}
}
func TestPostgresEvaluationSplitAndIndependentReview(t *testing.T) {
	s, ctx := integrationStore(t, true)
	first := integrationUser(t, s, ctx, "label-first@example.test", RoleAdmin, 0)
	second := integrationUser(t, s, ctx, "label-second@example.test", RoleAdmin, 0)
	stream := integrationStream(t, s, ctx)
	actorCtx := context.WithValue(ctx, userContextKey, first)
	ref, err := s.SaveCountingReference(actorCtx, stream.ID, preparationPNG(t))
	if err != nil {
		t.Fatal(err)
	}
	p, err := s.SaveCountingProfile(actorCtx, stream.ID, ref.ID, preparationDefinition())
	if err != nil {
		t.Fatal(err)
	}
	handler := NewAPI(s, Config{FrontendOrigin: "http://localhost:4200"}).Routes()
	cookies := []*http.Cookie{}
	for _, user := range []User{first, second} {
		token, _ := newSessionToken()
		if err = s.CreateSession(ctx, user.ID, sessionHash(token), time.Now().Add(time.Hour), ""); err != nil {
			t.Fatal(err)
		}
		cookies = append(cookies, &http.Cookie{Name: sessionCookieName, Value: token})
	}
	send := func(path string, input any, actor, status int) map[string]any {
		t.Helper()
		body, _ := json.Marshal(input)
		w := accountTestRequest(handler, "POST", path, string(body), cookies[actor])
		if w.Code != status {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
		var result map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &result)
		return result
	}
	start := time.Now().Add(-time.Hour).UTC()
	v := ManualInterval{ProfileID: p.ID, ClipSHA256: strings.Repeat("b", 64), Split: "tuning", DurationMS: 1000, Condition: "day", CaptureStart: &start, TimingEvidence: "Synthetic fixture: never real evaluation footage or camera truth.", Note: "Synthetic integration annotation; excluded from the real dataset.", Crossings: []ManualCrossing{{Track: "fixture-1", OffsetMS: 100, Class: "car", Direction: "A_to_B"}}}
	result := send("/api/admin/evaluation", v, 0, 201)
	id := int64(result["id"].(float64))
	v.Split = "test"
	send("/api/admin/evaluation", v, 0, 409)
	review := map[string]any{"outcome": "accepted", "note": "Independent check of a synthetic isolated fixture only."}
	send(fmt.Sprintf("/api/admin/evaluation/%d", id), review, 0, 409)
	send(fmt.Sprintf("/api/admin/evaluation/%d", id), review, 1, 409)
	v.ClipSHA256 = strings.Repeat("c", 64)
	v.CaptureStart = nil
	result = send("/api/admin/evaluation", v, 0, 201)
	send(fmt.Sprintf("/api/admin/evaluation/%.0f", result["id"]), review, 1, 409)
	if _, err = s.pool.Exec(ctx, `UPDATE evaluation_intervals SET dataset_split='test' WHERE id=$1`, id); err == nil {
		t.Fatal("evaluation annotation mutated")
	}
}
