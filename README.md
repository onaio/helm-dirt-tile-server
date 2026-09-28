# Dirt tile server Helm Chart

This chart bootsraps a [dirt tile server](https://github.com/onaio/dirt-simple-postgis-http-api) deployment

## Configuration

Refer to [values.yaml](values.yaml) for configuration options.

**Note** `configs` values default to work best with onadata

## Caching sidecar

Setting `auth.enabled` adds an nginx container to each pod and sends the Service's traffic to it instead of the tile server. For every tile and bounds request the sidecar:

1. refuses the request unless it names exactly one dataset and only parameters the tile server reads, each of them once;
2. asks whether the caller may read the dataset, and remembers the answer for a short time;
3. serves the response from its cache, or fetches it from the tile server and caches it.

```yaml
auth:
  enabled: true
```

| Value | Default | Meaning |
| --- | --- | --- |
| `auth.onadataUrl` | `configs.onadataurl` | Where permission is asked. Set it to reach the same service by a shorter route. |
| `auth.cacheTtlSeconds` | `60` | How long an approval is remembered. A change of access takes this long to show. |
| `auth.negativeCacheTtlSeconds` | `10` | How long a refusal is remembered. |
| `auth.tileCache.enabled` | `true` | Whether responses are cached. With `false` the sidecar only checks permission. |
| `auth.tileCache.ttlSeconds` | `10800` | How long a response is served before it is fetched again. Changes to the data take this long to show. |
| `auth.tileCache.maxSize` | `1g` | Most disk the cached responses may take, in each pod. |
| `auth.resources` | requests set | Keep a CPU request here when autoscaling on CPU, which needs one on every container. |

### What to know before enabling it

- **Responses are shared between callers.** A cached response is kept per dataset, not per caller, and is served to anyone allowed to read that dataset. This is only right while every caller allowed to read a dataset is meant to see the same submissions.
- **Permission is asked before every response**, cached or not, so a caller who loses access stops being served once the remembered approval lapses.
- **Each pod has a cache of its own**, held in an `emptyDir`. It starts empty when a pod starts and is not shared between replicas.
- **Add `nocache=<anything>`** to a request to fetch it afresh and replace what is cached.
- **The first tiles of a map view can wait up to half a second.** They arrive together; one asks for permission and the rest wait for its answer, which nginx checks for twice a second.
- **The token is kept out of the access log**, which records the path and the dataset. nginx's error log records the full request line, token included, for a request that fails.
- **Cross-origin headers come from the sidecar**, using `configs.corsorigins`, because a header cached with a response would be replayed to callers of other origins.

### Testing it

[tests/sidecar/run.sh](tests/sidecar/run.sh) renders the sidecar's configuration from this chart, and runs it in front of a real tile server and database in Docker. It needs `docker`, `helm` and `node`.

```bash
TILE_SERVER_IMAGE=onaio/dirt-tile-server:<tag> ./tests/sidecar/run.sh
```

The tests expect a tile server that refuses a request naming more than one dataset.
