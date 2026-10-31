FROM alpine:3.24 AS decoder-build
RUN apk add --no-cache build-base nasm curl gnupg xz
COPY build-decoder.sh /tmp/build-decoder.sh
RUN sh /tmp/build-decoder.sh

FROM golang:1.26.10-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api \
 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/create-admin ./cmd/create-admin \
 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/migrate ./cmd/migrate

FROM build AS test
RUN apk add --no-cache ffmpeg
COPY --from=decoder-build /out/decoder/bin/ffmpeg /opt/decoder/ffmpeg
COPY --from=decoder-build /out/decoder/bin/ffprobe /opt/decoder/ffprobe
ENV VIDEO_DECODER_TEST_PATH=/opt/decoder/ffmpeg
ENV VIDEO_FIXTURE_GENERATOR_PATH=/usr/bin/ffmpeg
CMD ["go", "test", "-count=1", "-v", "./..."]

FROM alpine:3.24
# Decoder execution is isolated by Go to retained local files. No source URL,
# cookie or credential is passed to FFmpeg. The API filesystem stays read-only.
RUN apk upgrade --no-cache && apk add --no-cache ca-certificates \
 && mkdir -p /app/evidence && chown 65532:65532 /app/evidence && chmod 700 /app/evidence
COPY --from=decoder-build /out/decoder/bin/ffmpeg /usr/bin/ffmpeg
COPY --from=decoder-build /out/decoder/bin/ffprobe /usr/bin/ffprobe
COPY --from=decoder-build /out/decoder/COPYING.LGPLv2.1 /out/decoder/source.sha256 /out/decoder/version.txt /out/decoder/protocols.txt /usr/share/licenses/trafficbet-decoder/
COPY --from=build /out/api /app/api
COPY --from=build /out/create-admin /app/create-admin
COPY --from=build /out/migrate /app/migrate
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/app/api"]
