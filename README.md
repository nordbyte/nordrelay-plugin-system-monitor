# NordRelay System Monitor Plugin

System Monitor is a NordRelay plugin that samples CPU, memory, disk, disk I/O,
network, pressure, thermal, battery, and long-term history metrics on every node
where it is installed and enabled.

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

The npm package is published as:

```text
@nordbyte/nordrelay-system-monitor
```

In the WebUI, open **Plugins**, select the target node in the header, and install
the GitHub source. Use **Install on all enabled peers** to install the same
plugin on all reachable peers without logging into each peer separately.

## Capabilities

- Collector: `system.sample`
- Commands: `sample`, `latest`, `history`, `panel-data`, `series`, `summary`, `export`, `status`, `storage`, `cleanup`, `vacuum`
- Web panel: `dashboard`
- Diagnostics: enabled

Required permission:

```text
system.metrics.read
```

The dashboard aggregates data only from peers where this plugin is installed,
enabled, and approved.

The dashboard stores long-term history in SQLite and renders current CPU usage,
CPU breakdown, per-core hotspots, CPU load averages, real memory in GB, swap,
memory pressure, page faults, local disk used/free space, inode usage, disk I/O,
network usage, network errors/drops/retransmits, thermals, battery state, alert
thresholds, node comparison, range summaries, and downsampled charts per peer.

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
| `trackDiskIo` | `true` | Collect disk throughput, IOPS, busy %, queue depth, and latency |
| `trackInodes` | `true` | Collect inode usage on Unix-like systems |
| `trackThermals` | `true` | Collect thermal sensors where available |
| `trackBattery` | `true` | Collect battery status where available |
| `thresholdCpuPercent` | `90` | CPU alert threshold |
| `thresholdMemoryPercent` | `90` | Memory alert threshold |
| `thresholdDiskPercent` | `90` | Disk and inode alert threshold |
| `thresholdSwapPercent` | `75` | Swap alert threshold |
| `thresholdIowaitPercent` | `25` | CPU I/O wait alert threshold |
| `thresholdDiskBusyPercent` | `85` | Disk busy alert threshold |

## Data

Samples are stored in the plugin data directory:

```text
~/.nordrelay/plugins/data/system-monitor/
```

The plugin writes:

- `metrics.sqlite`
- `state.json`

`metrics.sqlite` contains samples, disk rows, disk I/O rows, network rows,
per-core CPU rows, and rollups with indexes for range queries. `state.json` only
keeps lightweight counter snapshots needed to calculate CPU, disk, memory, and
network rates between samples.

Useful commands:

```sh
nordrelay plugin invoke system-monitor command panel-data --input-json '{"range":"24h","maxPoints":300}'
nordrelay plugin invoke system-monitor command summary --input-json '{"range":"7d"}'
nordrelay plugin invoke system-monitor command export --input-json '{"format":"csv","range":"30d","maxPoints":1000}'
nordrelay plugin invoke system-monitor command storage
nordrelay plugin invoke system-monitor command cleanup
nordrelay plugin invoke system-monitor command vacuum
```

## Development

```sh
npm run check
npm test
```
