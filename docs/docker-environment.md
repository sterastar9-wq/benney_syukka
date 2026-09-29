# Docker Environment

This container runs the GoQ automation Node tools while connecting to Chrome on
the Windows host through the Chrome DevTools Protocol.

## Build

```powershell
docker compose build
```

If `docker` is not on `PATH`, Docker Desktop's CLI is usually available at:

```powershell
& "C:\Program Files\Docker\Docker\resources\bin\docker.exe" compose build
```

## One-Click Startup

Double-click this file from Explorer:

```text
start-goq-docker.cmd
```

It will:

- find Docker CLI on `PATH` or under Docker Desktop's default install path
- start Docker Desktop when the engine is not ready
- build the Compose image
- start the `goq` container in the background
- map container file paths back to this Windows repository path for host Chrome

The container stays alive so commands can be run with `docker compose exec`.

## Run Local Checks

```powershell
docker compose run --rm goq npm run goq:review
docker compose run --rm goq node --check tools/goq-print-flow.mjs
docker compose exec goq npm run goq:review
```

## Connect To Host Chrome

Start Chrome on Windows with a remote debugging port such as `9223`, then run
tools with the same port:

```powershell
docker compose run --rm goq node tools/cdp-eval.mjs 9223 "location.href"
docker compose run --rm goq node tools/goq-print-flow.mjs --status nekoposu --port 9223
```

By default Compose sets:

```text
GOQ_CDP_HOST=host.docker.internal
GOQ_CONTAINER_WORKSPACE=/workspace
```

`start-goq-docker.cmd` also sets `GOQ_HOST_WORKSPACE` to this repository's
Windows path before running Compose. If you run Compose manually, set it first:

```powershell
$env:GOQ_HOST_WORKSPACE = (Resolve-Path .).Path
docker compose up -d goq
```

For a Linux host using host networking or when running tools outside Docker,
leave `GOQ_CDP_HOST` unset so the tools use `127.0.0.1`.

## Required Rule Material

The compose file mounts `${USERPROFILE}/.codex` read-only at `/root/.codex`.
This keeps the GoQ skill and memory files available to the runner inside the
container without copying them into the image.
