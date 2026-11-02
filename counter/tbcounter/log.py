from __future__ import annotations

import json
import logging
import sys
import time


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + f".{int(record.msecs):03d}Z",
                   "level": record.levelname.lower(), "logger": record.name, "msg": record.getMessage()}
        extra = getattr(record, "fields", None)
        if isinstance(extra, dict):
            payload.update(extra)
        if record.exc_info:
            payload["error"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str, ensure_ascii=False)


def setup(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(getattr(logging, level, logging.INFO))
    for noisy in ("urllib3", "PIL", "matplotlib"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def get(name: str) -> logging.LoggerAdapter:
    return _Adapter(logging.getLogger(name), {})


class _Adapter(logging.LoggerAdapter):
    def process(self, msg, kwargs):
        fields = {k: kwargs.pop(k) for k in list(kwargs) if k not in ("exc_info", "stack_info", "stacklevel", "extra")}
        kwargs.setdefault("extra", {})["fields"] = fields
        return msg, kwargs
