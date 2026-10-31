-- Official camera providers may publish periodically refreshed MP4 clips rather
-- than a continuous live HLS stream. Preserve that distinction in the model.
ALTER TABLE streams DROP CONSTRAINT streams_stream_type_check;
ALTER TABLE streams ADD CONSTRAINT streams_stream_type_check
    CHECK (stream_type IN ('hls', 'youtube', 'iframe', 'rtsp', 'image', 'mjpeg', 'mp4'));
