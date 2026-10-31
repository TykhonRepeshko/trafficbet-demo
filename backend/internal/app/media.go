package app

// The media gateway is deliberately not a general URL proxy. The only starting
// URL comes from an active database camera; further URLs must come from a bounded
// HLS manifest and are represented in the browser by short-lived opaque handles.
import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/netip"
	"net/textproto"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	mediaManifestLimit = 1 << 20
	mediaSegmentLimit  = 20 << 20
	mediaImageLimit    = 5 << 20
	mediaTokenLimit    = 4096
	mediaTokenLifetime = 10 * time.Minute
)

type mediaKind uint8

const (
	mediaManifest mediaKind = iota
	mediaSegment
	mediaKey
	mediaSnapshot
	mediaMJPEG
	mediaMP4
)

type mediaResource struct {
	streamID    int64
	fingerprint [32]byte
	upstream    *url.URL
	kind        mediaKind
	expires     time.Time
	lastUsed    time.Time
}

type mediaResolver interface {
	LookupNetIP(context.Context, string, string) ([]netip.Addr, error)
}

type MediaGateway struct {
	hosts     map[string]bool
	resolver  mediaResolver
	dial      func(context.Context, string, string) (net.Conn, error)
	rootCAs   *x509.CertPool
	mu        sync.Mutex
	resources map[string]mediaResource
	slots     chan struct{}
}

func parseMediaAllowedHosts(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	for i := range parts {
		parts[i] = strings.ToLower(strings.TrimSpace(parts[i]))
	}
	return parts
}

func validateMediaAllowedHosts(hosts []string) error {
	if len(hosts) > 64 {
		return fmt.Errorf("MEDIA_ALLOWED_HOSTS permits at most 64 exact hostnames")
	}
	for _, host := range hosts {
		u, err := url.Parse("https://" + host + "/")
		if err != nil || host == "" || u.Host != host || u.Hostname() != host || u.Path != "/" || u.RawQuery != "" || u.Fragment != "" || strings.HasSuffix(host, ".") || validatePublicURL(u.String(), true) != nil {
			return fmt.Errorf("MEDIA_ALLOWED_HOSTS must contain exact public DNS hostnames, without wildcards, ports or URLs")
		}
	}
	return nil
}

func NewMediaGateway(hosts []string) *MediaGateway {
	allowed := make(map[string]bool)
	// A directly constructed invalid configuration fails closed too.
	if validateMediaAllowedHosts(hosts) == nil {
		for _, host := range hosts {
			allowed[strings.ToLower(host)] = true
		}
	}
	dialer := &net.Dialer{Timeout: 4 * time.Second, KeepAlive: -1}
	return &MediaGateway{hosts: allowed, resolver: net.DefaultResolver, dial: dialer.DialContext, resources: make(map[string]mediaResource), slots: make(chan struct{}, 8)}
}

func (g *MediaGateway) allowedURL(u *url.URL) bool {
	if u == nil || validatePublicURL(u.String(), true) != nil || strings.HasSuffix(u.Hostname(), ".") || !g.hosts[strings.ToLower(u.Hostname())] {
		return false
	}
	// This public hostname is shared by many S3 customers. The built-in TfL
	// source is restricted to its official camera bucket, including redirects.
	if strings.EqualFold(u.Hostname(), "s3-eu-west-1.amazonaws.com") {
		if !strings.HasPrefix(u.Path, "/jamcams.tfl.gov.uk/") || strings.Contains(u.Path, "/../") || strings.Contains(u.Path, "/./") || u.RawPath != "" {
			return false
		}
	}
	return true
}

// Reject special-use ranges in addition to the standard library's predicates.
// In particular IsGlobalUnicast includes RFC1918 and documentation ranges.
var mediaDeniedPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"), netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("224.0.0.0/4"),
	netip.MustParsePrefix("240.0.0.0/4"), netip.MustParsePrefix("::/96"),
	netip.MustParsePrefix("64:ff9b::/96"), netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("100::/64"), netip.MustParsePrefix("2001::/23"),
	netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("2002::/16"),
	netip.MustParsePrefix("3fff::/20"), netip.MustParsePrefix("fec0::/10"),
	netip.MustParsePrefix("fc00::/7"), netip.MustParsePrefix("fe80::/10"),
}

func mediaPublicIP(address netip.Addr) bool {
	address = address.Unmap()
	if !address.IsValid() || !address.IsGlobalUnicast() || address.IsPrivate() || address.IsLoopback() || address.IsLinkLocalUnicast() {
		return false
	}
	if address.Is6() && !netip.MustParsePrefix("2000::/3").Contains(address) {
		return false
	}
	for _, prefix := range mediaDeniedPrefixes {
		if prefix.Contains(address) {
			return false
		}
	}
	return true
}

func (g *MediaGateway) transport(ctx context.Context, u *url.URL) (*http.Transport, error) {
	if !g.allowedURL(u) {
		return nil, errors.New("media upstream is not on the host allowlist")
	}
	host := strings.ToLower(u.Hostname())
	addresses, err := g.resolver.LookupNetIP(ctx, "ip", host)
	if err != nil || len(addresses) == 0 || len(addresses) > 32 {
		return nil, errors.New("media hostname resolution failed")
	}
	for _, address := range addresses {
		if !mediaPublicIP(address) {
			return nil, errors.New("media hostname resolved to a non-public address")
		}
	}
	// Resolve once, validate every result, and dial only those IPs. TLS still
	// verifies the original hostname, closing the DNS rebinding window.
	return &http.Transport{
		Proxy: nil, DisableKeepAlives: true, DisableCompression: true,
		TLSClientConfig:     &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12, RootCAs: g.rootCAs},
		TLSHandshakeTimeout: 4 * time.Second, ResponseHeaderTimeout: 5 * time.Second,
		MaxResponseHeaderBytes: 64 << 10,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			var lastErr error
			for _, ip := range addresses {
				conn, err := g.dial(ctx, "tcp", net.JoinHostPort(ip.String(), "443"))
				if err == nil {
					return conn, nil
				}
				lastErr = err
			}
			return nil, lastErr
		},
	}, nil
}

func (g *MediaGateway) fetch(ctx context.Context, upstream *url.URL, rangeHeader string) (*http.Response, error) {
	current := upstream
	for hop := 0; hop <= 3; hop++ {
		transport, err := g.transport(ctx, current)
		if err != nil {
			return nil, err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, current.String(), nil)
		if err != nil {
			return nil, errors.New("invalid media request")
		}
		req.Header.Set("User-Agent", "TrafficSim-MediaGateway/1.0")
		req.Header.Set("Accept-Encoding", "identity")
		if rangeHeader != "" {
			req.Header.Set("Range", rangeHeader)
		}
		client := &http.Client{Transport: transport, Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		response, err := client.Do(req)
		if err != nil {
			transport.CloseIdleConnections()
			return nil, fmt.Errorf("media upstream connection failed: %w", err)
		}
		switch response.StatusCode {
		case 301, 302, 303, 307, 308:
			response.Body.Close()
			transport.CloseIdleConnections()
			location := response.Header.Get("Location")
			if len(location) == 0 || len(location) > 2048 || hop == 3 {
				return nil, errors.New("media upstream redirect limit exceeded")
			}
			next, err := url.Parse(location)
			if err != nil {
				return nil, errors.New("invalid media redirect")
			}
			current = current.ResolveReference(next)
			// The following iteration validates HTTPS, host and all DNS results.
			continue
		}
		if response.StatusCode != http.StatusOK && !(response.StatusCode == http.StatusPartialContent && rangeHeader != "") {
			response.Body.Close()
			return nil, errors.New("media upstream returned an unsuccessful response")
		}
		if encoding := response.Header.Get("Content-Encoding"); encoding != "" && encoding != "identity" {
			response.Body.Close()
			return nil, errors.New("encoded media upstream response is unsupported")
		}
		return response, nil
	}
	return nil, errors.New("media upstream redirect limit exceeded")
}

func mediaFingerprint(stream Stream) [32]byte {
	return sha256.Sum256([]byte(stream.StreamType + "\x00" + stream.StreamURL))
}

func (g *MediaGateway) remember(stream Stream, u *url.URL, kind mediaKind, now time.Time) (string, error) {
	if !g.allowedURL(u) {
		return "", errors.New("manifest contains an unapproved upstream")
	}
	fingerprint := mediaFingerprint(stream)
	g.mu.Lock()
	defer g.mu.Unlock()
	oldestToken := ""
	var oldest time.Time
	for token, resource := range g.resources {
		if !now.Before(resource.expires) {
			delete(g.resources, token)
			continue
		}
		if resource.streamID == stream.ID && resource.fingerprint == fingerprint && resource.kind == kind && resource.upstream.String() == u.String() {
			resource.lastUsed = now
			resource.expires = now.Add(mediaTokenLifetime)
			g.resources[token] = resource
			return fmt.Sprintf("/api/media/streams/%d/resource/%s", stream.ID, token), nil
		}
		if oldestToken == "" || resource.lastUsed.Before(oldest) {
			oldestToken, oldest = token, resource.lastUsed
		}
	}
	if len(g.resources) >= mediaTokenLimit {
		delete(g.resources, oldestToken)
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", errors.New("could not allocate a media resource")
	}
	token := hex.EncodeToString(random[:])
	clone := *u
	g.resources[token] = mediaResource{streamID: stream.ID, fingerprint: fingerprint, upstream: &clone, kind: kind, expires: now.Add(mediaTokenLifetime), lastUsed: now}
	return fmt.Sprintf("/api/media/streams/%d/resource/%s", stream.ID, token), nil
}

func (g *MediaGateway) resource(stream Stream, token string, now time.Time) (mediaResource, bool) {
	if len(token) != 32 {
		return mediaResource{}, false
	}
	if _, err := hex.DecodeString(token); err != nil {
		return mediaResource{}, false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	resource, ok := g.resources[token]
	if !ok || !now.Before(resource.expires) || resource.streamID != stream.ID || resource.fingerprint != mediaFingerprint(stream) {
		return mediaResource{}, false
	}
	resource.lastUsed = now
	// A live player reloads the same child playlist for hours. Expire handles
	// after inactivity instead of cutting an active stream at ten minutes.
	// Camera/source binding and the global LRU bound remain enforced above.
	resource.expires = now.Add(mediaTokenLifetime)
	g.resources[token] = resource
	return resource, true
}

var mediaYouTubeID = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
var mediaRangePattern = regexp.MustCompile(`^bytes=([0-9]+-[0-9]*|-[0-9]+)$`)

type mediaHLSAttribute struct {
	value      string
	start, end int
	quoted     bool
}

func mediaHLSAttributes(text string) (map[string]mediaHLSAttribute, error) {
	attrs := make(map[string]mediaHLSAttribute)
	for offset := 0; offset < len(text); {
		keyStart := offset
		for offset < len(text) && (text[offset] >= 'A' && text[offset] <= 'Z' || text[offset] >= '0' && text[offset] <= '9' || text[offset] == '-') {
			offset++
		}
		if offset == keyStart || offset >= len(text) || text[offset] != '=' {
			return nil, errors.New("invalid HLS attribute name")
		}
		key := text[keyStart:offset]
		if _, duplicate := attrs[key]; duplicate {
			return nil, errors.New("duplicate HLS attribute")
		}
		offset++
		quoted := offset < len(text) && text[offset] == '"'
		if quoted {
			offset++
		}
		start := offset
		for offset < len(text) && (quoted && text[offset] != '"' || !quoted && text[offset] != ',') {
			if text[offset] == '\r' || text[offset] == '\n' || text[offset] == 0 || (!quoted && text[offset] == '"') {
				return nil, errors.New("invalid HLS attribute value")
			}
			offset++
		}
		end := offset
		if quoted {
			if offset == len(text) {
				return nil, errors.New("unterminated HLS attribute")
			}
			offset++
		}
		attrs[key] = mediaHLSAttribute{value: text[start:end], start: start, end: end, quoted: quoted}
		if offset == len(text) {
			break
		}
		if text[offset] != ',' || offset+1 == len(text) {
			return nil, errors.New("invalid HLS attribute separator")
		}
		offset++
	}
	return attrs, nil
}

func canonicalYouTubeURL(value string) string {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.Fragment != "" {
		return ""
	}
	var id string
	switch strings.ToLower(u.Hostname()) {
	case "www.youtube.com", "youtube.com", "m.youtube.com":
		if u.Path == "/watch" {
			id = u.Query().Get("v")
		} else if strings.HasPrefix(u.Path, "/live/") || strings.HasPrefix(u.Path, "/embed/") {
			id = path.Base(u.Path)
		}
	case "www.youtube-nocookie.com", "youtube-nocookie.com":
		if strings.HasPrefix(u.Path, "/embed/") {
			id = path.Base(u.Path)
		}
	case "youtu.be":
		id = strings.TrimPrefix(u.Path, "/")
	}
	if !mediaYouTubeID.MatchString(id) {
		return ""
	}
	return "https://www.youtube.com/watch?v=" + id
}

func (api *API) publicStream(stream Stream) Stream {
	upstream := stream.StreamURL
	thumbnail := stream.ThumbnailURL
	stream = publicStream(stream)
	if !stream.IsActive {
		stream.StreamURL = ""
		return stream
	}
	if thumbnailURL, err := url.Parse(thumbnail); api.media != nil && err == nil && api.media.allowedURL(thumbnailURL) {
		stream.ThumbnailURL = fmt.Sprintf("/api/media/streams/%d/snapshot", stream.ID)
	}
	if stream.StreamType == StreamTypeYouTube {
		stream.StreamURL = canonicalYouTubeURL(upstream)
		return stream
	}
	u, err := url.Parse(upstream)
	if api.media == nil || err != nil || !api.media.allowedURL(u) {
		return stream
	}
	switch stream.StreamType {
	case StreamTypeHLS:
		stream.StreamURL = fmt.Sprintf("/api/media/streams/%d/index.m3u8", stream.ID)
	case StreamTypeImage:
		stream.StreamURL = fmt.Sprintf("/api/media/streams/%d/snapshot", stream.ID)
	case StreamTypeMJPEG:
		stream.StreamURL = fmt.Sprintf("/api/media/streams/%d/mjpeg", stream.ID)
	case StreamTypeMP4:
		stream.StreamURL = fmt.Sprintf("/api/media/streams/%d/clip.mp4", stream.ID)
	}
	return stream
}

func (g *MediaGateway) rewriteManifest(stream Stream, base *url.URL, body []byte, now time.Time) ([]byte, error) {
	if len(body) > mediaManifestLimit || !bytes.HasPrefix(body, []byte("#EXTM3U")) || bytes.IndexByte(body, 0) >= 0 {
		return nil, errors.New("invalid HLS manifest")
	}
	lines := strings.Split(strings.ReplaceAll(string(body), "\r\n", "\n"), "\n")
	if len(lines) > 10000 || strings.TrimSpace(lines[0]) != "#EXTM3U" {
		return nil, errors.New("HLS manifest contains too many lines")
	}
	nextManifest := false
	resourceCount := 0
	rewrite := func(value string, kind mediaKind) (string, error) {
		resourceCount++
		if resourceCount > 512 || value == "" || len(value) > 2048 || strings.Contains(value, "{$") || strings.ContainsAny(value, "\r\n\x00") {
			return "", errors.New("unsupported HLS resource")
		}
		u, err := url.Parse(value)
		if err != nil {
			return "", errors.New("invalid HLS resource URL")
		}
		return g.remember(stream, base.ResolveReference(u), kind, now)
	}
	for i, raw := range lines {
		line := strings.TrimSpace(raw)
		// An ended/VOD playlist must never silently become a live camera replay.
		if line == "#EXT-X-ENDLIST" || line == "#EXT-X-PLAYLIST-TYPE:VOD" {
			return nil, errors.New("camera source is an ended or recorded HLS playlist")
		}
		if len(line) > 16384 || strings.ContainsAny(line, "\r\x00") {
			return nil, errors.New("invalid HLS manifest line")
		}
		if line == "" {
			continue
		}
		if !strings.HasPrefix(line, "#") {
			kind := mediaSegment
			if nextManifest || strings.EqualFold(path.Ext(strings.SplitN(line, "?", 2)[0]), ".m3u8") {
				kind = mediaManifest
			}
			value, err := rewrite(line, kind)
			if err != nil {
				return nil, err
			}
			lines[i], nextManifest = value, false
			continue
		}
		if !strings.HasPrefix(line, "#EXT") {
			lines[i] = "" // Provider comments may contain operational URLs.
			continue
		}
		tag, attrs, hasAttrs := strings.Cut(line, ":")
		if tag == "#EXT-X-STREAM-INF" {
			nextManifest = true
		}
		if tag == "#EXT-X-CONTENT-STEERING" || tag == "#EXT-X-DEFINE" {
			return nil, errors.New("HLS steering and variable imports are unsupported")
		}
		if !hasAttrs || !strings.Contains(attrs, "URI") {
			continue
		}
		attributes, err := mediaHLSAttributes(attrs)
		if err != nil {
			return nil, err
		}
		uri, hasURI := attributes["URI"]
		if !hasURI || !uri.quoted || uri.value == "" {
			return nil, errors.New("invalid HLS URI attribute")
		}
		for name := range attributes {
			if name != "URI" && strings.Contains(name, "URI") {
				return nil, errors.New("unsupported HLS URI attribute")
			}
		}
		kind := mediaSegment
		switch tag {
		case "#EXT-X-MEDIA", "#EXT-X-I-FRAME-STREAM-INF", "#EXT-X-RENDITION-REPORT":
			kind = mediaManifest
		case "#EXT-X-KEY", "#EXT-X-SESSION-KEY":
			if attributes["METHOD"].value != "AES-128" {
				return nil, errors.New("only standard AES-128 HLS encryption is supported")
			}
			if format, exists := attributes["KEYFORMAT"]; exists && format.value != "identity" {
				return nil, errors.New("external HLS key formats are unsupported")
			}
			kind = mediaKey
		case "#EXT-X-MAP", "#EXT-X-PART", "#EXT-X-PRELOAD-HINT":
		default:
			return nil, errors.New("unsupported URI-bearing HLS tag")
		}
		value, err := rewrite(uri.value, kind)
		if err != nil {
			return nil, err
		}
		lines[i] = tag + ":" + attrs[:uri.start] + value + attrs[uri.end:]
	}
	return []byte(strings.Join(lines, "\n")), nil
}

func mediaReadLimit(reader io.Reader, limit int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil || int64(len(body)) > limit {
		return nil, errors.New("media response exceeded its size limit or was interrupted")
	}
	return body, nil
}

func mediaContentType(value string, kind mediaKind) (string, bool) {
	contentType, _, err := mime.ParseMediaType(value)
	if err != nil {
		return "", false
	}
	switch kind {
	case mediaManifest:
		return "application/vnd.apple.mpegurl", contentType == "application/vnd.apple.mpegurl" || contentType == "application/x-mpegurl" || contentType == "audio/mpegurl" || contentType == "audio/x-mpegurl" || contentType == "text/plain"
	case mediaSegment:
		for _, allowed := range []string{"video/mp2t", "video/mp4", "audio/mp4", "audio/aac", "audio/mpeg", "application/octet-stream"} {
			if contentType == allowed {
				return contentType, true
			}
		}
	case mediaKey:
		return "application/octet-stream", contentType == "application/octet-stream" || contentType == "binary/octet-stream"
	case mediaSnapshot:
		return contentType, contentType == "image/jpeg" || contentType == "image/png" || contentType == "image/webp"
	case mediaMJPEG:
		return contentType, contentType == "multipart/x-mixed-replace"
	case mediaMP4:
		return "video/mp4", contentType == "video/mp4"
	}
	return "", false
}

func mediaImageMatches(body []byte, contentType string) bool {
	switch contentType {
	case "image/jpeg":
		return len(body) >= 4 && body[0] == 0xff && body[1] == 0xd8 && body[2] == 0xff
	case "image/png":
		return bytes.HasPrefix(body, []byte("\x89PNG\r\n\x1a\n"))
	case "image/webp":
		return len(body) >= 12 && string(body[:4]) == "RIFF" && string(body[8:12]) == "WEBP"
	}
	return false
}

func validMediaRange(value string) bool {
	if value == "" {
		return true
	}
	if len(value) > 64 || !mediaRangePattern.MatchString(value) {
		return false
	}
	startText, endText, ok := strings.Cut(strings.TrimPrefix(value, "bytes="), "-")
	if !ok {
		return false
	}
	if startText == "" {
		suffix, err := strconv.ParseInt(endText, 10, 64)
		return err == nil && suffix > 0 && suffix <= mediaSegmentLimit
	}
	start, err := strconv.ParseInt(startText, 10, 64)
	if err != nil || start < 0 || start > 1<<40 {
		return false
	}
	if endText == "" {
		return true // A response is still bounded to mediaSegmentLimit below.
	}
	end, err := strconv.ParseInt(endText, 10, 64)
	return err == nil && end >= start && end-start < mediaSegmentLimit
}

func validMediaContentRange(value string, bodyLength int) bool {
	if len(value) > 100 || !strings.HasPrefix(value, "bytes ") {
		return false
	}
	interval, totalText, ok := strings.Cut(strings.TrimPrefix(value, "bytes "), "/")
	startText, endText, dash := strings.Cut(interval, "-")
	if !ok || !dash {
		return false
	}
	for _, part := range []string{startText, endText, totalText} {
		if part == "" {
			return false
		}
		for _, char := range part {
			if char < '0' || char > '9' {
				return false
			}
		}
	}
	start, e1 := strconv.ParseInt(startText, 10, 64)
	end, e2 := strconv.ParseInt(endText, 10, 64)
	total, e3 := strconv.ParseInt(totalText, 10, 64)
	return e1 == nil && e2 == nil && e3 == nil && start >= 0 && end >= start && end < total && end-start+1 == int64(bodyLength)
}

func (api *API) handleMedia(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		methodNotAllowed(w)
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/media/streams/"), "/")
	if r.URL.RawQuery != "" || r.URL.RawPath != "" || len(parts) < 2 || len(parts) > 3 || api.media == nil {
		writeError(w, http.StatusNotFound, "media_not_found", "Media resource was not found.")
		return
	}
	id, err := parseID(parts[0])
	if err != nil || strconv.FormatInt(id, 10) != parts[0] {
		writeError(w, http.StatusNotFound, "media_not_found", "Media resource was not found.")
		return
	}
	stream, err := api.store.GetStream(r.Context(), id)
	if err != nil || !stream.IsActive {
		writeError(w, http.StatusNotFound, "media_not_found", "Media resource was not found.")
		return
	}
	startingURL := stream.StreamURL
	if len(parts) == 2 && parts[1] == "snapshot" && stream.StreamType != StreamTypeImage && stream.ThumbnailURL != "" {
		startingURL = stream.ThumbnailURL
	}
	upstream, err := url.Parse(startingURL)
	kind := mediaManifest
	if err != nil || !api.media.allowedURL(upstream) {
		writeError(w, http.StatusServiceUnavailable, "media_not_configured", "The camera source is not enabled on this server.")
		return
	}
	switch {
	case len(parts) == 2 && parts[1] == "index.m3u8" && stream.StreamType == StreamTypeHLS:
	case len(parts) == 2 && parts[1] == "snapshot" && stream.StreamType == StreamTypeImage:
		kind = mediaSnapshot
	case len(parts) == 2 && parts[1] == "snapshot" && stream.ThumbnailURL != "":
		upstream, err = url.Parse(stream.ThumbnailURL)
		if err != nil || !api.media.allowedURL(upstream) {
			writeError(w, http.StatusServiceUnavailable, "media_not_configured", "The camera snapshot is not enabled on this server.")
			return
		}
		kind = mediaSnapshot
	case len(parts) == 2 && parts[1] == "mjpeg" && stream.StreamType == StreamTypeMJPEG:
		kind = mediaMJPEG
	case len(parts) == 2 && parts[1] == "clip.mp4" && stream.StreamType == StreamTypeMP4:
		kind = mediaMP4
	case len(parts) == 3 && parts[1] == "resource" && stream.StreamType == StreamTypeHLS:
		resource, ok := api.media.resource(stream, parts[2], time.Now())
		if !ok {
			writeError(w, http.StatusNotFound, "media_expired", "Media resource expired. Reload the camera.")
			return
		}
		upstream, kind = resource.upstream, resource.kind
	default:
		writeError(w, http.StatusNotFound, "media_not_found", "Media resource was not found.")
		return
	}
	rangeHeader := r.Header.Get("Range")
	if !validMediaRange(rangeHeader) || (rangeHeader != "" && kind != mediaSegment && kind != mediaMP4) {
		writeError(w, http.StatusRequestedRangeNotSatisfiable, "media_range_invalid", "Media range is outside the permitted limits.")
		return
	}
	select {
	case api.media.slots <- struct{}{}:
		defer func() { <-api.media.slots }()
	default:
		w.Header().Set("Retry-After", "2")
		writeError(w, http.StatusServiceUnavailable, "media_busy", "The camera gateway is busy. Try again shortly.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	response, err := api.media.fetch(ctx, upstream, rangeHeader)
	if err != nil {
		writeError(w, http.StatusBadGateway, "media_unavailable", "The camera source is currently unavailable.")
		return
	}
	defer response.Body.Close()
	contentType, ok := mediaContentType(response.Header.Get("Content-Type"), kind)
	if !ok {
		writeError(w, http.StatusBadGateway, "media_format_invalid", "The camera returned an unsupported media format.")
		return
	}
	if kind == mediaMJPEG {
		api.media.writeMJPEG(w, r, response)
		return
	}
	limit := int64(mediaSegmentLimit)
	switch kind {
	case mediaManifest:
		limit = mediaManifestLimit
	case mediaSnapshot:
		limit = mediaImageLimit
	case mediaKey:
		limit = 16
	}
	if response.ContentLength > limit {
		writeError(w, http.StatusBadGateway, "media_size_invalid", "The camera response exceeded the permitted size.")
		return
	}
	body, err := mediaReadLimit(response.Body, limit)
	if err == nil && kind == mediaManifest {
		// Relative references follow the final, validated redirect destination.
		body, err = api.media.rewriteManifest(stream, response.Request.URL, body, time.Now())
	}
	if err != nil || (kind == mediaKey && len(body) != 16) || (kind == mediaSnapshot && !mediaImageMatches(body, contentType)) || (response.StatusCode == http.StatusPartialContent && !validMediaContentRange(response.Header.Get("Content-Range"), len(body))) {
		writeError(w, http.StatusBadGateway, "media_invalid", "The camera returned invalid or unsupported media.")
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	if modified, err := http.ParseTime(response.Header.Get("Last-Modified")); err == nil {
		w.Header().Set("Last-Modified", modified.UTC().Format(http.TimeFormat))
	}
	if response.StatusCode == http.StatusPartialContent {
		// This header is data, never a URL. Do not relay any other upstream headers.
		w.Header().Set("Content-Range", response.Header.Get("Content-Range"))
		w.Header().Set("Accept-Ranges", "bytes")
		w.WriteHeader(http.StatusPartialContent)
	}
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}

func (g *MediaGateway) writeMJPEG(w http.ResponseWriter, r *http.Request, response *http.Response) {
	_, params, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || params["boundary"] == "" || len(params["boundary"]) > 70 {
		writeError(w, http.StatusBadGateway, "media_invalid", "The camera returned invalid multipart media.")
		return
	}
	reader := multipart.NewReader(io.LimitReader(response.Body, mediaSegmentLimit+1), params["boundary"])
	writer := multipart.NewWriter(w)
	w.Header().Set("Content-Type", "multipart/x-mixed-replace; boundary="+writer.Boundary())
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	if r.Method == http.MethodHead {
		return
	}
	// Reframe every part: upstream headers and non-image payloads never pass
	// through. Connections end after eight seconds and have a total byte cap.
	for frames := 0; frames < 100; frames++ {
		part, err := reader.NextPart()
		if err != nil {
			break
		}
		contentType, ok := mediaContentType(part.Header.Get("Content-Type"), mediaSnapshot)
		body, err := mediaReadLimit(part, 2<<20)
		part.Close()
		if !ok || err != nil || !mediaImageMatches(body, contentType) {
			break
		}
		header := make(textproto.MIMEHeader)
		header.Set("Content-Type", contentType)
		header.Set("Content-Length", strconv.Itoa(len(body)))
		output, err := writer.CreatePart(header)
		if err != nil {
			break
		}
		if _, err := output.Write(body); err != nil {
			break
		}
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
	}
	_ = writer.Close()
}
