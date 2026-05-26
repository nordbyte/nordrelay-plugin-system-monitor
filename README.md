# NordRelay System Monitor Plugin

System Monitor is a NordRelay plugin that samples CPU, memory, disk, and
network usage on every node where it is installed and enabled.

The plugin is intentionally self-contained: NordRelay provides the plugin host,
peer routing, scheduling, permissions, and WebUI panel container; all metrics
collection, history, cleanup, and rendering logic lives in this plugin.

## Install

Install on the current node:

```sh
nordrelay plugin install github:nordbyte/nordrelay-plugin-system-monitor --enable --approve
```

Install from a local checkout:

```sh
nordrelay plugin install /path/to/nordrelay-plugin-system-monitor --enable --approve
```

The plugin has no npm runtime dependencies. It uses the `node:sqlite` runtime
module available in supported NordRelay Node.js versions.

In the WebUI, open **Plugins**, select the target node in the header, and install
the GitHub source. Use **Install on all enabled peers** to install the same
plugin on all reachable peers without logging into each peer separately.

## Capabilities

- Collector: `system.sample`
- Commands: `sample`, `latest`, `history`, `panel-data`, `series`, `summary`, `status`, `storage`, `cleanup`, `vacuum`
- Web panel: `dashboard`
- Diagnostics: enabled

Required permission:

```text
system.metrics.read
```

The dashboard aggregates data only from peers where this plugin is installed,
enabled, and approved.

The dashboard stores long-term history in SQLite and renders current values,
range summaries, and downsampled charts per peer.

## Settings

| Setting | Default | Description |
| --- | ---: | --- |
| `sampleIntervalMs` | `5000` | Preferred collector interval in milliseconds |
| `retentionDays` | `30` | Metrics history retention in days |
| `maxChartPoints` | `240` | Maximum downsampled points returned for charts |
| `cleanupIntervalMinutes` | `30` | Minimum time between automatic retention cleanup runs |
| `autoRefreshMs` | `10000` | Default panel auto-refresh interval |
| `trackDisks` | `true` | Collect disk usage |
| `trackNetworkInterfaces` | `true` | Collect network counters |

## Data

Samples are stored in the plugin data directory:

```text
~/.nordrelay/plugins/data/system-monitor/
```

The plugin writes:

- `metrics.sqlite`
- `state.json`

`metrics.sqlite` contains samples, disk rows, and network rows with indexes for
range queries. `state.json` only keeps lightweight counter snapshots needed to
calculate CPU and network rates between samples.

Useful commands:

```sh
nordrelay plugin invoke system-monitor command panel-data --input-json '{"range":"24h","maxPoints":300}'
nordrelay plugin invoke system-monitor command summary --input-json '{"range":"7d"}'
nordrelay plugin invoke system-monitor command storage
nordrelay plugin invoke system-monitor command cleanup
nordrelay plugin invoke system-monitor command vacuum
```

## Development

```sh
npm run check
npm test
```
