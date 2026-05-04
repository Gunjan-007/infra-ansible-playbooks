
'use strict';

const express = require('express');
const si      = require('systeminformation');
const os      = require('os');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Helpers ────────────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${d}d ${h}h ${m}m ${s}s`;
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync('/var/log/app.log', line); } catch (_) {}
}

// ── Routes ─────────────────────────────────────────────────────────────

// Health check — ALB hits this every 30 seconds
app.get('/health', (req, res) => {
  res.status(200).json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    hostname:  os.hostname(),
    uptime:    formatUptime(os.uptime())
  });
});

// Dashboard — quick summary of all key metrics in one call
app.get('/api/dashboard', async (req, res) => {
  try {
    const [load, mem, disks, nets] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.networkStats()
    ]);

    res.json({
      hostname:   os.hostname(),
      timestamp:  new Date().toISOString(),
      uptime:     formatUptime(os.uptime()),
      cpu: {
        load_percent: parseFloat(load.currentLoad.toFixed(2))
      },
      memory: {
        total:        formatBytes(mem.total),
        used:         formatBytes(mem.used),
        free:         formatBytes(mem.free),
        used_percent: parseFloat(((mem.used / mem.total) * 100).toFixed(2))
      },
      disk: disks[0] ? {
        mount:        disks[0].mount,
        total:        formatBytes(disks[0].size),
        used:         formatBytes(disks[0].used),
        free:         formatBytes(disks[0].available),
        used_percent: parseFloat(disks[0].use.toFixed(2))
      } : null,
      network: nets[0] ? {
        interface: nets[0].iface,
        rx_sec:    formatBytes(nets[0].rx_sec) + '/s',
        tx_sec:    formatBytes(nets[0].tx_sec) + '/s'
      } : null
    });
  } catch (err) {
    log(`ERROR /api/dashboard: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// System overview — OS info, CPU specs, memory summary
app.get('/api/system', async (req, res) => {
  try {
    const [cpu, mem, osInfo] = await Promise.all([
      si.cpu(),
      si.mem(),
      si.osInfo()
    ]);
    const load = await si.currentLoad();

    res.json({
      hostname: os.hostname(),
      uptime:   formatUptime(os.uptime()),
      os: {
        platform: osInfo.platform,
        distro:   osInfo.distro,
        release:  osInfo.release,
        arch:     osInfo.arch,
        kernel:   osInfo.kernel
      },
      cpu: {
        manufacturer:   cpu.manufacturer,
        brand:          cpu.brand,
        speed_ghz:      cpu.speed,
        cores_physical: cpu.physicalCores,
        cores_logical:  cpu.cores,
        load_percent:   parseFloat(load.currentLoad.toFixed(2))
      },
      memory: {
        total:        formatBytes(mem.total),
        used:         formatBytes(mem.used),
        free:         formatBytes(mem.free),
        used_percent: parseFloat(((mem.used / mem.total) * 100).toFixed(2))
      }
    });
  } catch (err) {
    log(`ERROR /api/system: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// CPU — per-core load breakdown
app.get('/api/cpu', async (req, res) => {
  try {
    const [load, temp] = await Promise.all([
      si.currentLoad(),
      si.cpuTemperature()
    ]);

    res.json({
      hostname:          os.hostname(),
      load_percent:      parseFloat(load.currentLoad.toFixed(2)),
      load_user:         parseFloat(load.currentLoadUser.toFixed(2)),
      load_system:       parseFloat(load.currentLoadSystem.toFixed(2)),
      per_core:          load.cpus.map((c, i) => ({
        core:         i,
        load_percent: parseFloat(c.load.toFixed(2))
      })),
      temperature_c: temp.main || 'unavailable'
    });
  } catch (err) {
    log(`ERROR /api/cpu: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Memory — RAM and swap breakdown
app.get('/api/memory', async (req, res) => {
  try {
    const mem = await si.mem();
    res.json({
      hostname:     os.hostname(),
      total:        formatBytes(mem.total),
      used:         formatBytes(mem.used),
      free:         formatBytes(mem.free),
      active:       formatBytes(mem.active),
      available:    formatBytes(mem.available),
      used_percent: parseFloat(((mem.used / mem.total) * 100).toFixed(2)),
      swap: {
        total:        formatBytes(mem.swaptotal),
        used:         formatBytes(mem.swapused),
        free:         formatBytes(mem.swapfree),
        used_percent: mem.swaptotal > 0
          ? parseFloat(((mem.swapused / mem.swaptotal) * 100).toFixed(2))
          : 0
      }
    });
  } catch (err) {
    log(`ERROR /api/memory: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Disk — all mounted filesystems
app.get('/api/disk', async (req, res) => {
  try {
    const disks = await si.fsSize();
    res.json({
      hostname:    os.hostname(),
      filesystems: disks.map(d => ({
        mount:        d.mount,
        type:         d.type,
        total:        formatBytes(d.size),
        used:         formatBytes(d.used),
        free:         formatBytes(d.available),
        used_percent: parseFloat(d.use.toFixed(2))
      }))
    });
  } catch (err) {
    log(`ERROR /api/disk: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Network — interfaces and live throughput
app.get('/api/network', async (req, res) => {
  try {
    const [ifaces, stats] = await Promise.all([
      si.networkInterfaces(),
      si.networkStats()
    ]);

    res.json({
      hostname:   os.hostname(),
      interfaces: ifaces
        .filter(i => !i.internal)
        .map(i => ({
          name:      i.iface,
          ip4:       i.ip4,
          mac:       i.mac,
          speed_mbps: i.speed
        })),
      throughput: stats
        .filter(s => !s.iface.startsWith('lo'))
        .map(s => ({
          interface: s.iface,
          rx_total:  formatBytes(s.rx_bytes),
          tx_total:  formatBytes(s.tx_bytes),
          rx_sec:    formatBytes(s.rx_sec) + '/s',
          tx_sec:    formatBytes(s.tx_sec) + '/s'
        }))
    });
  } catch (err) {
    log(`ERROR /api/network: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Processes — top 10 by CPU usage
app.get('/api/processes', async (req, res) => {
  try {
    const procs = await si.processes();
    const top10 = procs.list
      .sort((a, b) => b.cpu - a.cpu)
      .slice(0, 10)
      .map(p => ({
        pid:         p.pid,
        name:        p.name,
        cpu_percent: parseFloat(p.cpu.toFixed(2)),
        mem_percent: parseFloat(p.mem.toFixed(2)),
        state:       p.state
      }));

    res.json({
      hostname:         os.hostname(),
      total:            procs.all,
      running:          procs.running,
      sleeping:         procs.sleeping,
      top10_by_cpu:     top10
    });
  } catch (err) {
    log(`ERROR /api/processes: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// 404 handler — tells caller which endpoints are valid
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    available: [
      '/health',
      '/api/dashboard',
      '/api/system',
      '/api/cpu',
      '/api/memory',
      '/api/disk',
      '/api/network',
      '/api/processes'
    ]
  });
});

// ── Start ──────────────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  log(`sysmon listening on 127.0.0.1:${PORT}`);
});
