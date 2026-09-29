# Dirt tile server Helm Chart

This chart bootsraps a [dirt tile server](https://github.com/onaio/dirt-simple-postgis-http-api) deployment

## Configuration

Refer to [values.yaml](values.yaml) for configuration options.

**Note** `configs` values default to work best with onadata

## Caching sidecar

Setting `sidecar.enabled` adds an nginx container to each pod and sends the Service's traffic to it instead of the tile server. For every tile and bounds request the sidecar:

1. refuses the request unless it names exactly one dataset and only parameters the tile server reads, each of them once;
2. asks whether the caller may read the dataset, and remembers the answer for a short time;
3. serves the response from its cache, or fetches it from the tile server and caches it.

```yaml
sidecar:
  enabled: true
```

| Value | Default | Meaning |
| --- | --- | --- |
| `sidecar.onadataUrl` | `configs.onadataurl` | Where permission is asked: a scheme, a host and nothing else. The sidecar's resolver knows no search domains, so an in-cluster address must be given in full, as `onadata.onadata.svc.cluster.local`. |
| `sidecar.permissionConnectTimeoutSeconds` | `3` | How long to wait to reach the service that grants permission. |
| `sidecar.permissionReadTimeoutSeconds` | `5` | How long to wait for its answer. Every request waits for one, so this bounds how long the sidecar holds a request when that service is unwell. |
| `sidecar.permissionTtlSeconds` | `60` | How long an approval is remembered. A change of access takes this long to show. |
| `sidecar.refusalTtlSeconds` | `10` | How long a refusal is remembered. |
| `sidecar.responseCache.enabled` | `true` | Whether responses are cached. With `false` the sidecar only checks permission. |
| `sidecar.responseCache.ttlSeconds` | `10800` | How long a response is served before it is fetched again. Changes to the data take this long to show. |
| `sidecar.responseCache.maxSize` | `1g` | Most disk the cached responses may take, in each pod. |
| `sidecar.responseCache.volumeSize` | `2Gi` | Room for the cached responses and the remembered answers beside them. |
| `sidecar.workerConnections` | `4096` | Connections one worker may hold. A request in flight uses up to three. |
| `sidecar.resources` | requests set | Keep a CPU request here when autoscaling on CPU, which needs one on every container. |
| `sidecar.securityContext` | unprivileged | The sidecar runs as user 101 with a read-only root filesystem and no capabilities. |

### What to know before enabling it

- **Responses are shared between callers.** A cached response is kept per dataset, not per caller, and is served to anyone allowed to read that dataset. This is only right while every caller allowed to read a dataset is meant to see the same submissions.
- **Permission is asked before every response**, cached or not, so a caller who loses access stops being served once the remembered approval lapses.
- **Each pod has a cache of its own**, held in an `emptyDir`. It starts empty when a pod starts and is not shared between replicas.
- **Add `nocache=<anything>`** to a request to fetch it afresh and replace what is cached.
- **The first tiles of a map view can wait up to half a second.** They arrive together; one asks for permission and the rest wait for its answer, which nginx checks for twice a second.
- **The token is kept out of the access log**, which records the path and the dataset. nginx's error log records the full request line, token included, for a request that fails.
- **Cross-origin headers come from the sidecar**, using `configs.corsorigins`, which is a comma-separated list. A header cached with a response would otherwise be replayed to callers of other origins.
- **Turning it on or off interrupts the service.** The Service moves to the sidecar's port as soon as the change is applied, and pods without it drop out until the new ones are ready. Roll it out when a short interruption is acceptable.
- **Nothing of the caller's reaches the service that grants permission** but the token, so an approval cannot be won by a cookie and then kept under a token that did not earn it.

### Testing it

[tests/sidecar/run.sh](tests/sidecar/run.sh) renders the sidecar's configuration from this chart, and runs it in front of a real tile server and database in Docker. It needs `docker`, `helm` and `node`.

```bash
TILE_SERVER_IMAGE=onaio/dirt-tile-server:<tag> ./tests/sidecar/run.sh
```

The tests expect a tile server that refuses a request naming more than one dataset. They run nginx as the chart runs it: an unprivileged user, a read-only root filesystem and no capabilities.
