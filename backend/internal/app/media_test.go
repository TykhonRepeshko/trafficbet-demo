package app

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"testing"
	"time"
)

type mediaTestResolver struct {
	addresses []netip.Addr
	calls     int
}

func (r *mediaTestResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	r.calls++
	return r.addresses, nil
}

func mediaTestURL(t *testing.T, value string) *url.URL {
	t.Helper()
	u, err := url.Parse(value)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func TestMediaRejectsRecordedOrEndedHLS(t *testing.T) {
	g := NewMediaGateway([]string{"video.deldot.gov"})
	base := mediaTestURL(t, "https://video.deldot.gov/live/KCAM001.stream/playlist.m3u8")
	stream := Stream{ID: 1, StreamType: StreamTypeHLS, StreamURL: base.String()}
	for _, tag := range []string{"#EXT-X-ENDLIST", "#EXT-X-PLAYLIST-TYPE:VOD"} {
		body := []byte("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXTINF:10,\ncurrent.ts\n" + tag + "\n")
		if _, err := g.rewriteManifest(stream, base, body, time.Now()); err == nil {
			t.Fatalf("recorded camera playlist accepted: %s", tag)
		}
	}
	if _, err := g.rewriteManifest(stream, base, []byte("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:11\n#EXTINF:10,\ncurrent.ts\n"), time.Now()); err != nil {
		t.Fatalf("ongoing public live playlist rejected: %v", err)
	}
}

func TestMediaHostAllowlist(t *testing.T) {
	for _, input := range []string{"*.example.com", "example.com:443", "https://example.com", "example.com/path", "example.com?x=y", "example.com#x", "127.0.0.1", "localhost", "camera.local", "example.com.", "example.com,", "user@example.com"} {
		if validateMediaAllowedHosts(parseMediaAllowedHosts(input)) == nil {
			t.Errorf("unsafe allowlist accepted: %s", input)
		}
	}
	allowed := parseMediaAllowedHosts(" EXAMPLE.COM, cdn.example.com ")
	if err := validateMediaAllowedHosts(allowed); err != nil {
		t.Fatal(err)
	}
	g := NewMediaGateway(allowed)
	for _, input := range []string{"http://example.com/a", "https://example.com.evil.org/a", "https://sub.example.com/a", "https://user:pass@example.com/a", "https://example.com:8443/a", "https://example.com./a", "https://127.0.0.1/a"} {
		if g.allowedURL(mediaTestURL(t, input)) {
			t.Errorf("unsafe URL accepted: %s", input)
		}
	}
	if !g.allowedURL(mediaTestURL(t, "https://example.com/a?server_token=secret")) {
		t.Fatal("configured upstream with a server-side token was rejected")
	}
	s3 := NewMediaGateway([]string{"s3-eu-west-1.amazonaws.com"})
	for _, input := range []string{"https://s3-eu-west-1.amazonaws.com/other-bucket/feed.mp4", "https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/../private.mp4", "https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/%2e%2e/private.mp4"} {
		if s3.allowedURL(mediaTestURL(t, input)) {
			t.Errorf("shared S3 host escaped the TfL bucket: %s", input)
		}
	}
	if !s3.allowedURL(mediaTestURL(t, "https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00001.07450.mp4")) {
		t.Fatal("official TfL clip rejected")
	}
}

func TestMediaPublicIP(t *testing.T) {
	for _, input := range []string{"0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.0.1", "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::", "::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "100::1", "2001:db8::1", "2002:7f00:1::", "3fff::1", "fc00::1", "fe80::1", "fec0::1", "ff02::1"} {
		if mediaPublicIP(netip.MustParseAddr(input)) {
			t.Errorf("special-use address accepted: %s", input)
		}
	}
	for _, input := range []string{"1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"} {
		if !mediaPublicIP(netip.MustParseAddr(input)) {
			t.Errorf("public address rejected: %s", input)
		}
	}
}

func TestMediaDNSValidationAndPinnedDial(t *testing.T) {
	g := NewMediaGateway([]string{"example.com"})
	resolver := &mediaTestResolver{addresses: []netip.Addr{netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("127.0.0.1")}}
	g.resolver = resolver
	dials := 0
	g.dial = func(context.Context, string, string) (net.Conn, error) { dials++; return nil, errors.New("test dial") }
	if _, err := g.transport(context.Background(), mediaTestURL(t, "https://example.com/a")); err == nil || dials != 0 {
		t.Fatal("mixed public/private DNS records were not rejected before connecting")
	}
	resolver.addresses = []netip.Addr{netip.MustParseAddr("93.184.216.34")}
	transport, err := g.transport(context.Background(), mediaTestURL(t, "https://example.com/a"))
	if err != nil {
		t.Fatal(err)
	}
	before := resolver.calls
	resolver.addresses = []netip.Addr{netip.MustParseAddr("127.0.0.1")}
	var dialed string
	g.dial = func(_ context.Context, network, address string) (net.Conn, error) {
		dialed = address
		return nil, errors.New("test dial")
	}
	_, _ = transport.DialContext(context.Background(), "tcp", "example.com:443")
	if dialed != "93.184.216.34:443" || resolver.calls != before || transport.Proxy != nil || transport.TLSClientConfig.ServerName != "example.com" || transport.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("dial was not pinned to the originally validated public IP with verified TLS")
	}
	if _, err := g.transport(context.Background(), mediaTestURL(t, "https://example.com/b")); err == nil {
		t.Fatal("a subsequent fetch did not revalidate DNS")
	}
}

type mediaPipeListener struct {
	conn net.Conn
}

func (l *mediaPipeListener) Accept() (net.Conn, error) {
	if l.conn == nil {
		return nil, io.EOF
	}
	conn := l.conn
	l.conn = nil
	return conn, nil
}
func (l *mediaPipeListener) Close() error   { return nil }
func (l *mediaPipeListener) Addr() net.Addr { return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)} }

func mediaTestGateway(t *testing.T, handler http.Handler) (*MediaGateway, *mediaTestResolver) {
	t.Helper()
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)
	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())
	g := NewMediaGateway([]string{"example.com"})
	g.rootCAs = pool
	resolver := &mediaTestResolver{addresses: []netip.Addr{netip.MustParseAddr("93.184.216.34")}}
	g.resolver = resolver
	// Exercise real TLS and HTTP without a loopback network exception in the
	// sandbox. Production still dials only the resolved, validated public IPs.
	g.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "93.184.216.34:443" {
			return nil, errors.New("test observed an unvalidated dial")
		}
		clientConn, serverConn := net.Pipe()
		listener := &mediaPipeListener{conn: tls.Server(serverConn, server.TLS)}
		go func() { _ = http.Serve(listener, handler) }()
		return clientConn, nil
	}
	return g, resolver
}

func TestMediaFetchRedirectPolicy(t *testing.T) {
	for _, tc := range []struct {
		name      string
		location  string
		wantError bool
	}{{"same host", "/final", false}, {"different host", "https://evil.example.org/private", true}, {"HTTP downgrade", "http://example.com/final", true}, {"IP redirect", "https://127.0.0.1/private", true}, {"redirect loop", "/start", true}} {
		t.Run(tc.name, func(t *testing.T) {
			g, resolver := mediaTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" || r.Header.Get("Referer") != "" {
					t.Error("browser credentials forwarded to camera")
				}
				if r.URL.Path == "/start" {
					w.Header().Set("Location", tc.location)
					w.WriteHeader(http.StatusFound)
					return
				}
				w.Header().Set("Content-Type", "video/mp4")
				_, _ = io.WriteString(w, "clip")
			}))
			response, err := g.fetch(context.Background(), mediaTestURL(t, "https://example.com/start"), "")
			if response != nil {
				defer response.Body.Close()
			}
			if (err != nil) != tc.wantError {
				t.Fatalf("fetch error %v; wanted error=%v", err, tc.wantError)
			}
			if !tc.wantError && (resolver.calls != 2 || response.Request.URL.Path != "/final") {
				t.Fatal("redirect did not resolve and validate its own destination")
			}
			if tc.name == "redirect loop" && resolver.calls != 4 {
				t.Fatalf("redirect loop performed %d connections, wanted 4", resolver.calls)
			}
		})
	}
}

func TestMediaFetchRejectsEncodedAndErrorResponses(t *testing.T) {
	for _, tc := range []struct {
		status   int
		encoding string
	}{{200, "gzip"}, {404, ""}, {500, ""}, {206, ""}} {
		g, _ := mediaTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if tc.encoding != "" {
				w.Header().Set("Content-Encoding", tc.encoding)
			}
			w.WriteHeader(tc.status)
		}))
		if response, err := g.fetch(context.Background(), mediaTestURL(t, "https://example.com/a"), ""); err == nil {
			response.Body.Close()
			t.Fatalf("invalid response accepted: %#v", tc)
		}
	}
}

func TestHLSManifestRewritesAndBindsAllResources(t *testing.T) {
	g := NewMediaGateway([]string{"example.com", "cdn.example.com"})
	stream := Stream{ID: 7, StreamType: StreamTypeHLS, StreamURL: "https://example.com/live/master.m3u8?api_key=secret", IsActive: true}
	now := time.Now()
	manifest := `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="main",URI="https://cdn.example.com/audio.m3u8?token=audio-secret"
#EXT-X-STREAM-INF:BANDWIDTH=100000,AUDIO="audio"
variant/index.m3u8?key=private
`
	body, err := g.rewriteManifest(stream, mediaTestURL(t, stream.StreamURL), []byte(manifest), now)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "example.com") || strings.Contains(string(body), "secret") || strings.Contains(string(body), "private") {
		t.Fatal("upstream manifest URL or credentials leaked")
	}
	if len(g.resources) != 2 {
		t.Fatalf("expected two rewritten master resources, got %d", len(g.resources))
	}
	for token, resource := range g.resources {
		if resource.kind != mediaManifest || !strings.Contains(string(body), "/api/media/streams/7/resource/"+token) {
			t.Fatal("nested manifest not rewritten")
		}
		if _, ok := g.resource(Stream{ID: 8, StreamType: stream.StreamType, StreamURL: stream.StreamURL}, token, now); ok {
			t.Fatal("resource token was accepted for another camera")
		}
		changed := stream
		changed.StreamURL += "-changed"
		if _, ok := g.resource(changed, token, now); ok {
			t.Fatal("resource survived a camera source change")
		}
		if _, ok := g.resource(stream, token, now.Add(mediaTokenLifetime)); ok {
			t.Fatal("expired resource token was accepted")
		}
	}
	variant := `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-KEY:METHOD=AES-128,URI="../keys/key.bin?secret=key",IV=0x00000000000000000000000000000001
#EXT-X-MAP:URI="init.mp4"
#EXT-X-PART:DURATION=0.5,URI="part.m4s"
#EXTINF:6,
segment.ts?secret=segment
`
	if _, err := g.rewriteManifest(stream, mediaTestURL(t, "https://example.com/live/variant/index.m3u8"), []byte(variant), now); err != nil {
		t.Fatal(err)
	}
	kinds := map[mediaKind]int{}
	for _, resource := range g.resources {
		kinds[resource.kind]++
		if resource.kind == mediaKey && resource.upstream.String() != "https://example.com/live/keys/key.bin?secret=key" {
			t.Fatal("relative AES key resolved incorrectly")
		}
	}
	if kinds[mediaKey] != 1 || kinds[mediaSegment] != 3 {
		t.Fatalf("resource kinds were not preserved: %v", kinds)
	}
}

func TestHLSManifestFailsClosed(t *testing.T) {
	g := NewMediaGateway([]string{"example.com"})
	stream := Stream{ID: 1, StreamType: StreamTypeHLS, StreamURL: "https://example.com/index.m3u8"}
	for _, manifest := range []string{
		"<html>not video</html>", "#EXTM3U\nhttps://evil.example.org/segment.ts\n", "#EXTM3U\nhttp://example.com/segment.ts\n", "#EXTM3U\nhttps://127.0.0.1/secret\n",
		"#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"key\"\n", "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,KEYFORMAT=\"com.apple.streamingkeydelivery\",URI=\"key\"\n",
		"#EXTM3U\n#EXT-X-MAP:URI=\"one\",URI=\"two\"\n", "#EXTM3U\n#EXT-X-MAP:URI=https://example.com/init.mp4\n", "#EXTM3U\n#EXT-X-CONTENT-STEERING:SERVER-URI=\"https://example.com/a\"\n",
		"#EXTM3U\n#EXT-X-DEFINE:IMPORT=\"secret\"\n", "#EXTM3U\n{$host}/file.ts\n", "#EXTM3U\n#EXT-X-SESSION-DATA:URI=\"metadata.json\"\n", "#EXTM3U\n\x00hidden\n",
		"#EXTM3U\n" + strings.Repeat("a", 16385), "#EXTM3U\n" + strings.Repeat("# comment\n", 10001), "#EXTM3U\n" + strings.Repeat("#", mediaManifestLimit),
	} {
		if _, err := g.rewriteManifest(stream, mediaTestURL(t, stream.StreamURL), []byte(manifest), time.Now()); err == nil {
			t.Errorf("unsafe manifest accepted: %.150s", manifest)
		}
	}
}

func TestMediaResourceMemoryBound(t *testing.T) {
	g := NewMediaGateway([]string{"example.com"})
	stream := Stream{ID: 1, StreamType: StreamTypeHLS, StreamURL: "https://example.com/index.m3u8"}
	now := time.Now()
	for i := 0; i < mediaTokenLimit+10; i++ {
		if _, err := g.remember(stream, mediaTestURL(t, fmt.Sprintf("https://example.com/%d.ts", i)), mediaSegment, now.Add(time.Duration(i)*time.Millisecond)); err != nil {
			t.Fatal(err)
		}
	}
	if len(g.resources) != mediaTokenLimit {
		t.Fatal("media resource map is not bounded")
	}
	if _, err := g.remember(stream, mediaTestURL(t, "https://example.com/fresh.ts"), mediaSegment, now.Add(time.Hour)); err != nil || len(g.resources) != 1 {
		t.Fatal("expired media resources were not removed")
	}
}

func TestMediaActiveLivePlaylistSurvivesPastInitialExpiry(t *testing.T) {
	g := NewMediaGateway([]string{"example.com"})
	stream := Stream{ID: 7, StreamType: StreamTypeHLS, StreamURL: "https://example.com/live/index.m3u8"}
	now := time.Unix(1700000000, 0)
	resourcePath, err := g.remember(stream, mediaTestURL(t, "https://example.com/live/child.m3u8"), mediaManifest, now)
	if err != nil {
		t.Fatal(err)
	}
	token := resourcePath[strings.LastIndex(resourcePath, "/")+1:]
	for minute := 9; minute <= 63; minute += 9 {
		if _, ok := g.resource(stream, token, now.Add(time.Duration(minute)*time.Minute)); !ok {
			t.Fatalf("actively watched playlist expired at minute %d", minute)
		}
	}
	changed := stream
	changed.StreamURL = "https://example.com/replaced/index.m3u8"
	if _, ok := g.resource(changed, token, now.Add(72*time.Minute)); ok {
		t.Fatal("source replacement retained access to an old live playlist")
	}
	if _, ok := g.resource(Stream{ID: 8, StreamType: stream.StreamType, StreamURL: stream.StreamURL}, token, now.Add(72*time.Minute)); ok {
		t.Fatal("another camera renewed the live playlist handle")
	}
	if _, ok := g.resource(stream, token, now.Add(73*time.Minute)); ok {
		t.Fatal("idle handle did not expire, or rejected access renewed it")
	}
}

func TestMediaByteAndContentLimits(t *testing.T) {
	if _, err := mediaReadLimit(strings.NewReader("12345"), 4); err == nil {
		t.Fatal("response body size limit bypassed")
	}
	if body, err := mediaReadLimit(strings.NewReader("1234"), 4); err != nil || string(body) != "1234" {
		t.Fatal("exact byte limit rejected")
	}
	for _, kind := range []mediaKind{mediaManifest, mediaSegment, mediaKey, mediaSnapshot, mediaMJPEG, mediaMP4} {
		for _, contentType := range []string{"text/html", "image/svg+xml", "application/javascript"} {
			if _, ok := mediaContentType(contentType, kind); ok {
				t.Fatalf("active content accepted: %s, kind %v", contentType, kind)
			}
		}
	}
	for _, value := range []string{"bytes=0-99", "bytes=100-", "bytes=-100", ""} {
		if !validMediaRange(value) {
			t.Errorf("valid range rejected: %s", value)
		}
	}
	for _, value := range []string{"bytes=0-1,2-3", "bytes=1-0", "bytes=-0", "bytes=-999999999", "bytes=0-999999999", "bytes=99999999999999999999-", "items=0-1", "bytes=-", "bytes=1--1", "bytes=+1-2", "bytes=-+10"} {
		if validMediaRange(value) {
			t.Errorf("unsafe range accepted: %s", value)
		}
	}
	if !validMediaContentRange("bytes 10-19/100", 10) {
		t.Fatal("valid partial response rejected")
	}
	for _, value := range []string{"bytes 10-19/100\r\nX-Secret: value", "bytes 10-19/19", "bytes 20-10/100", "bytes 10-19/*", "bytes 10-20/100"} {
		if validMediaContentRange(value, 10) {
			t.Errorf("invalid partial response accepted: %s", value)
		}
	}
	if mediaImageMatches([]byte("<svg><script>bad</script></svg>"), "image/png") {
		t.Fatal("non-image snapshot accepted")
	}
}

func TestMediaPublicPathsAndYouTubeSanitization(t *testing.T) {
	api := &API{media: NewMediaGateway([]string{"example.com"})}
	for _, tc := range []struct{ kind, suffix string }{{StreamTypeHLS, "index.m3u8"}, {StreamTypeImage, "snapshot"}, {StreamTypeMJPEG, "mjpeg"}, {StreamTypeMP4, "clip.mp4"}} {
		stream := Stream{ID: 42, StreamType: tc.kind, StreamURL: "https://example.com/feed?token=private", ThumbnailURL: "https://example.com/snapshot.jpg?token=private", IsActive: true}
		public := api.publicStream(stream)
		if public.StreamURL != "/api/media/streams/42/"+tc.suffix || public.ThumbnailURL != "/api/media/streams/42/snapshot" {
			t.Fatalf("incorrect public paths: %#v", public)
		}
		stream.IsActive = false
		if api.publicStream(stream).StreamURL != "" || api.publicStream(stream).ThumbnailURL != "" {
			t.Fatal("inactive camera has a media path")
		}
	}
	for _, value := range []string{"https://www.youtube.com/watch?v=abcdefghijk&secret=private", "https://youtu.be/abcdefghijk?t=5", "https://www.youtube.com/live/abcdefghijk"} {
		if canonicalYouTubeURL(value) != "https://www.youtube.com/watch?v=abcdefghijk" {
			t.Errorf("valid video rejected: %s", value)
		}
	}
	for _, value := range []string{"https://youtube.com.evil.org/watch?v=abcdefghijk", "https://www.youtube.com/watch?v=../../evil", "https://user:pass@www.youtube.com/watch?v=abcdefghijk", "http://youtu.be/abcdefghijk", "https://www.youtube.com:443/watch?v=abcdefghijk"} {
		if canonicalYouTubeURL(value) != "" {
			t.Errorf("unsafe embed accepted: %s", value)
		}
	}
}

func TestMJPEGReframesImagesAndDropsUpstreamHeaders(t *testing.T) {
	var input bytes.Buffer
	input.WriteString("--source\r\nContent-Type: image/jpeg\r\nSet-Cookie: secret=private\r\n\r\n")
	input.Write([]byte{0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9})
	input.WriteString("\r\n--source\r\nContent-Type: text/html\r\n\r\n<script>bad</script>\r\n--source--\r\n")
	response := &http.Response{Header: http.Header{"Content-Type": []string{"multipart/x-mixed-replace; boundary=source"}}, Body: io.NopCloser(&input)}
	w := httptest.NewRecorder()
	NewMediaGateway(nil).writeMJPEG(w, httptest.NewRequest("GET", "/", nil), response)
	if strings.Contains(w.Body.String(), "secret") || strings.Contains(w.Body.String(), "script") || !bytes.Contains(w.Body.Bytes(), []byte{0xff, 0xd8, 0xff}) {
		t.Fatal("MJPEG did not safely reframe only image parts")
	}
}

func TestYouTubeThumbnailRemainsScopedToAllowedMediaGateway(t *testing.T) {
	api := &API{media: NewMediaGateway([]string{"i.ytimg.com"})}
	stream := Stream{ID: 7, IsActive: true, StreamType: StreamTypeYouTube, StreamURL: "https://www.youtube.com/watch?v=8H3nRCFVR6Y", ThumbnailURL: "https://i.ytimg.com/vi/8H3nRCFVR6Y/hqdefault.jpg"}
	visible := api.publicStream(stream)
	if visible.ThumbnailURL != "/api/media/streams/7/snapshot" || visible.StreamURL == "" {
		t.Fatal("YouTube preview is not exposed through its camera gateway")
	}
	stream.ThumbnailURL = "https://unapproved.example/secret.jpg"
	if api.publicStream(stream).ThumbnailURL != "" {
		t.Fatal("unapproved thumbnail escaped the allowlist")
	}
	stream.IsActive = false
	stream.ThumbnailURL = "https://i.ytimg.com/vi/8H3nRCFVR6Y/hqdefault.jpg"
	if api.publicStream(stream).ThumbnailURL != "" {
		t.Fatal("inactive camera exposed media")
	}
}

type thumbnailRouteResolver struct{ hosts []string }

func (r *thumbnailRouteResolver) LookupNetIP(_ context.Context, _ string, host string) ([]netip.Addr, error) {
	r.hosts = append(r.hosts, host)
	return nil, errors.New("intentionally unavailable test DNS")
}
func TestPostgresYouTubeSnapshotValidatesItsOwnUpstream(t *testing.T) {
	store, ctx := integrationStore(t, true)
	camera, err := store.CreateStream(ctx, Stream{Title: "Live camera", City: "Tokyo", Country: "Japan", LocationLabel: "Shibuya", StreamType: StreamTypeYouTube, StreamURL: "https://www.youtube.com/watch?v=8H3nRCFVR6Y", ThumbnailURL: "https://i.ytimg.com/vi/8H3nRCFVR6Y/hqdefault.jpg", IsActive: true})
	if err != nil {
		t.Fatal(err)
	}
	api := NewAPI(store, Config{FrontendOrigin: "http://localhost:4200", MediaAllowedHosts: []string{"i.ytimg.com"}})
	resolver := &thumbnailRouteResolver{}
	api.media.resolver = resolver
	route := fmt.Sprintf("/api/media/streams/%d/snapshot", camera.ID)
	recorder := httptest.NewRecorder()
	api.Routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, route, nil))
	if recorder.Code != http.StatusBadGateway || len(resolver.hosts) != 1 || resolver.hosts[0] != "i.ytimg.com" {
		t.Fatalf("snapshot did not validate its own upstream: status=%d hosts=%v", recorder.Code, resolver.hosts)
	}
	camera.ThumbnailURL = "https://unapproved.example/secret.jpg"
	if _, err := store.UpdateStream(ctx, camera); err != nil {
		t.Fatal(err)
	}
	recorder = httptest.NewRecorder()
	api.Routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, route, nil))
	if recorder.Code != http.StatusServiceUnavailable || len(resolver.hosts) != 1 {
		t.Fatal("unapproved thumbnail entered DNS/network")
	}
}
