# Deployment

Operational guide for shipping a change to the deployed pocket-dev on Tower (`192.168.86.183`). For repo orientation and gotchas, see `CLAUDE.md`. For end-user setup, see `README.md`.

## CI

Two GitHub Actions workflows run on every push:

| Workflow | Trigger | Job |
|---|---|---|
| `test.yml` | push to `main`, every PR | vitest (unit + server) + Playwright e2e on Chromium + Firefox |
| `docker-publish.yml` | push to `main`, tags `v*`, manual dispatch | builds `linux/amd64` + `linux/arm64`, pushes `ghcr.io/jacob-lasky/pocket-dev:latest` (plus PR / branch / version tags) |

`test.yml` blocks merge on failure. `docker-publish.yml` only runs against `main` and tags — PRs build but don't push.

## Shipping a change

1. Branch off `main`, commit, push, open PR.
2. Wait for `test.yml` green. Iterate until it is.
3. Merge to `main` — squash-merge is fine. `docker-publish.yml` fires on the merge commit, builds the multi-arch image, pushes to GHCR. Typical end-to-end: ~5 minutes.

## Deploying on Tower

The deployed container is managed via the UnRAID Docker tab, which reads `/boot/config/plugins/dockerMan/templates-user/my-pocket-dev.xml`. The template is the source of truth for the run args (PUID=99, PGID=100, `--group-add 281`, volume mounts, port maps).

To pull the new image and recreate the container:

```sh
ssh tower
docker pull ghcr.io/jacob-lasky/pocket-dev:latest
# Then either:
#   - UnRAID Docker tab → click pocket-dev → "Force Update" (uses the template), OR
#   - docker stop pocket-dev && docker rm pocket-dev
#     and let UnRAID's "auto-start" re-create it from the template on the next array event.
```

The first option is the normal path. The second is only needed if the container is wedged.

## Verifying the deploy

After redeploy:

```sh
# Live page renders
curl -sf http://192.168.86.183:7681/ | head -3

# Boot log clean
ssh tower 'docker logs --tail 30 pocket-dev'

# Image SHA matches what just shipped
ssh tower 'docker inspect pocket-dev --format "{{.Image}}"'
ssh tower 'docker images ghcr.io/jacob-lasky/pocket-dev --format "{{.ID}} {{.CreatedSince}}"'
```

For UI-touching changes, open `http://192.168.86.183:7681/` on the device that will actually use it (typically a phone) and exercise the affected flow. Mobile Safari and desktop Chromium can render the same CSS differently — there is an open follow-up to add WebKit to the test matrix, but until that lands, the phone is the canonical "did the fix land" check.

## Rolling back

```sh
ssh tower
docker pull ghcr.io/jacob-lasky/pocket-dev:<previous-sha-or-tag>
docker tag ghcr.io/jacob-lasky/pocket-dev:<previous> ghcr.io/jacob-lasky/pocket-dev:latest
# Then re-create the container via the UnRAID tab as above.
```

Previous SHAs are visible in the GHCR package page (`https://github.com/users/Jacob-Lasky/packages/container/pocket-dev`). Branch tags from open PRs (`pr-N`) are also pullable if a hotfix needs to come from a branch.
