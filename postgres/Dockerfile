FROM postgres:16-alpine

# Preserve the official PostgreSQL 16 server, entrypoint and data layout. Stable
# OS updates and Alpine's small privilege-drop helper avoid executing the old Go
# runtime/dependencies bundled into the upstream gosu binary. The entrypoint's
# fixed `gosu postgres ...` invocation has the same semantics with su-exec.
RUN apk upgrade --no-cache \
 && apk add --no-cache su-exec \
 && rm /usr/local/bin/gosu \
 && cp /sbin/su-exec /usr/local/bin/gosu \
 && gosu postgres sh -c 'test "$(id -u)" = 70 && test "$(id -g)" = 70'
