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

In the WebUI, open **Plugins**, select the target node in the header, and install
the GitHub source. Use **Install on all enabled peers** to install the same
plugin on all reachable peers without logging into each peer separately.

## Capabilities

- Collector: `system.sample`
- Commands: `sample`, `latest`, `history`, `status`, `cleanup`
- Web panel: `dashboard`
- Diagnostics: enabled

Required permission:

```text
system.metrics.read
```

The dashboard aggregates data only from peers where this plugin is installed,
enabled, and approved.

## Settings

| Setting | Default | Description |
| --- | ---: | --- |
| `sampleIntervalMs` | `5000` | Preferred collector interval in milliseconds |
| `retentionHours` | `72` | Metrics history retention |
| `trackDisks` | `true` | Collect disk usage |
| `trackNetworkInterfaces` | `true` | Collect network counters |

## Data

Samples are stored in the plugin data directory:

```text
~/.nordrelay/plugins/data/system-monitor/
```

The plugin writes:

- `samples.jsonl`
- `state.json`

## Development

```sh
npm run check
npm test
```
