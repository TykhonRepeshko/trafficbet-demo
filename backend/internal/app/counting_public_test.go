package app

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
)

func TestPostgresPublicCountingGuideMatchesSourceAndHidesPrivateEvidence(t *testing.T) {
	s, ctx := integrationStore(t, true)
	admin := integrationUser(t, s, ctx, "public-guide-admin@example.test", RoleAdmin, 0)
	ctx = context.WithValue(ctx, userContextKey, admin)
	stream := integrationStream(t, s, ctx)
	reference, err := s.SaveCountingReference(ctx, stream.ID, preparationPNG(t))
	if err != nil {
		t.Fatal(err)
	}
	definition := preparationDefinition()
	definition.Notes = "Private operator review notes must never be included in the public guide."
	profile, err := s.SaveCountingProfile(ctx, stream.ID, reference.ID, definition)
	if err != nil {
		t.Fatal(err)
	}
	handler := NewAPI(s, Config{FrontendOrigin: "http://localhost:4200"}).Routes()
	check := func(path string) *PublicCountingGuide {
		t.Helper()
		w := accountTestRequest(handler, "GET", path, "", nil)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		var items []Stream
		if path == "/api/streams" {
			err = json.Unmarshal(w.Body.Bytes(), &items)
		} else {
			var item Stream
			err = json.Unmarshal(w.Body.Bytes(), &item)
			items = []Stream{item}
		}
		if err != nil || len(items) != 1 {
			t.Fatal("public camera decode", err)
		}
		guide := items[0].CountingGuide
		if guide != nil && (guide.Definition.Notes != "" || guide.Width != 64 || guide.Height != 40) {
			t.Fatal("private notes leaked or reference dimensions lost", guide)
		}
		return guide
	}
	for _, path := range []string{"/api/streams", fmt.Sprintf("/api/streams/%d", stream.ID)} {
		guide := check(path)
		if guide == nil || guide.ProfileID != profile.ID || guide.Approved {
			t.Fatal("draft guide missing or incorrectly approved", guide)
		}
	}
	if err = s.ApproveCountingProfile(ctx, stream.ID, profile.ID, "Reference line checked against the matching source framing."); err != nil {
		t.Fatal(err)
	}
	if !check("/api/streams").Approved {
		t.Fatal("selected approval missing")
	}
	newer := definition
	newer.LineStart.Y = .7
	newer.LineEnd.Y = .7
	if _, err = s.SaveCountingProfile(ctx, stream.ID, reference.ID, newer); err != nil {
		t.Fatal(err)
	}
	if check("/api/streams").ProfileID != profile.ID {
		t.Fatal("unselected draft replaced the approved line")
	}
	if _, err = s.pool.Exec(ctx, `UPDATE streams SET stream_url=stream_url || '?changed=1' WHERE id=$1`, stream.ID); err != nil {
		t.Fatal(err)
	}
	if check("/api/streams") != nil {
		t.Fatal("old line shown over a changed camera source")
	}
}
