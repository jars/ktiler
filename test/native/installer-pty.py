"""Run a command with a private terminal and answer prompts in order."""

import errno
import json
import os
import pty
import select
import sys
import time


steps = iter(json.loads(sys.argv[1]))
child, terminal = pty.fork()
if child == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
step = next(steps, None)
buffer = b""
deadline = time.monotonic() + 25
try:
    while time.monotonic() < deadline:
        if not select.select([terminal], [], [], 0.2)[0]:
            continue
        try:
            chunk = os.read(terminal, 4096)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            break
        if not chunk:
            break
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
        if step:
            buffer += chunk
            marker, reply = step
            start = buffer.find(marker.encode())
            if start != -1:
                os.write(terminal, reply.encode() + b"\n")
                buffer = buffer[start + len(marker.encode()):]
                step = next(steps, None)
    else:
        raise RuntimeError("Installer PTY timed out")
    if step:
        raise RuntimeError(f"Missing prompt: {step[0]}")
except BaseException:
    os.kill(child, 15)
    raise
finally:
    os.close(terminal)

sys.exit(os.waitstatus_to_exitcode(os.waitpid(child, 0)[1]))
