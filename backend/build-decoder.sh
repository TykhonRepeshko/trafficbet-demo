#!/bin/sh
# Local-file H.264 evidence tools only; Go retains all network authorization.
set -eu
version=9.0.2
mkdir -p /src/decoder /out/decoder
cd /src/decoder
for resource in "releases/ffmpeg-$version.tar.xz" "releases/ffmpeg-$version.tar.xz.asc" ffmpeg-devel.asc; do
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 --retry 2 "https://ffmpeg.org/$resource" --output "${resource##*/}"
done
fingerprint=$(gpg --batch --show-keys --with-colons ffmpeg-devel.asc | awk -F: '$1=="fpr" {print $10; exit}')
test "$fingerprint" = FCF986EA15E6E293A5644F10B4322F04D67658D8
gpg --batch --import ffmpeg-devel.asc
gpg --batch --status-fd 1 --verify "ffmpeg-$version.tar.xz.asc" "ffmpeg-$version.tar.xz" > signature.status
grep -q '^\[GNUPG:\] VALIDSIG FCF986EA15E6E293A5644F10B4322F04D67658D8 ' signature.status
sha256sum "ffmpeg-$version.tar.xz" > /out/decoder/source.sha256
tar -xJf "ffmpeg-$version.tar.xz"
cd "ffmpeg-$version"
./configure --prefix=/out/decoder --disable-everything --disable-autodetect \
  --disable-network --disable-doc --disable-debug --disable-shared --enable-static \
  --enable-small --disable-avdevice --disable-swresample --disable-iconv \
  --enable-ffmpeg --enable-ffprobe --enable-avfilter --enable-swscale \
  --enable-protocol=file,pipe --enable-decoder=h264 --enable-parser=h264 \
  --enable-demuxer=mpegts,mov --enable-muxer=mp4,rawvideo --enable-encoder=rawvideo \
  --enable-filter=fps,scale,format,buffer,buffersink,trim,null,showinfo \
  --enable-bsf=h264_mp4toannexb,extract_extradata \
  --extra-ldflags='-static -Wl,-z,stack-size=2097152'
make -j4
make install
cp COPYING.LGPLv2.1 /out/decoder/
./ffmpeg -hide_banner -protocols > /out/decoder/protocols.txt
./ffmpeg -version > /out/decoder/version.txt
# Fail if a future configure change accidentally restores network protocols.
test "$(sed -n '/Input:/,/Output:/p' /out/decoder/protocols.txt | sed '1d;$d' | tr -d ' \n')" = filepipe
