'use strict';

const express = require('express');
const si = require('systeminformation');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

// Helper: format bytes
const formatBytes = (bytes) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
};

// ── Routes ─────────────────────────────────────────────────────────────

// Health check — ALB pings this
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    hostname: os.hostname()
  });
});

// System overview
app.get('/api/system', async (req, res) => {
  try {
    const [cpu, mem, osInfo, time] = await Promise.all([
      si.cpu(),
      si.mem(),
      si.osInfo(),
      si.time()
    ]);

    res.json({
      hostname: os.hostname(),
      uptime_seconds: os.uptime(),
      uptime_human: formatUptime(os.uptime()),
      os: {
        platform: osInfo.platform,
        distro: osInfo.distro,
        release: osInfo.release,
        arch: osInfo.arch,
        kernel: osInfo.kernel
      },
      cpu: {
        manufacturer: cpu.manufacturer,
        brand: cpu.brand,
        cores_physical: cpu.physicalCores,
        cores_logical: cpu.cores,
        speed_ghz: cpu.speed,
        load_percent: (await si.currentLoad()).currentLoad.toFixed(2)
      },
      memory: {
        total: formatBytes(mem.total),
        used: formatBytes(mem.used),
        free: formatBytes(mem.free),
        used_percent: ((mem.used / mem.total) * 100).toFixed(2)
      },
      time: {
        current: time.current,
        timezone: time.timezone,
        timezoneName: time.timezoneName
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CPU details
app.get('/api/cpu', async (req, res) => {
  try {
    const [load, temp] = await Promise.all([
      si.currentLoad(),
      si.cpuTemperature()
    ]);

    res.json({
      hostname: os.hostname(),
      load_percent: load.currentLoad.toFixed(2),
      load_per_core: load.cpus.map((c, i) => ({
        core: i,
        load_percent: c.load.toFixed(2)
      })),
      temperature_celsius: temp.main || 'N/A'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Memory details
app.get('/api/memory', async (req, res) => {
  try {
    const mem = await si.mem();
    res.json({
      hostname: os.hostname(),
      total: formatBytes(mem.total),
      used: formatBytes(mem.used),
      free: formatBytes(mem.free),
      active: formatBytes(mem.active),
      available: formatBytes(mem.available),
      swap_total: formatBytes(mem.swaptotal),
      swap_used: formatBytes(mem.swapused),
      used_percent: ((mem.used / mem.total) * 100).toFixed(2)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Disk details
app.get('/api/disk', async (req, res) => {
  try {
    const [disks, io] = await Promise.all([
      si.fsSize(),
      si.disksIO()
    ]);

    res.json({
      hostname: os.hostname(),
      filesystems: disks.map(d => ({
        mount: d.mount,
        type: d.type,
        size: formatBytes(d.size),
        used: formatBytes(d.used),
        available: formatBytes(d.available),
        used_percent: d.use.toFixed(2)
      })),
      io: {
        read_bytes: formatBytes(io.rIO_sec || 0) + '/s',
        write_bytes: formatBytes(io.wIO_sec || 0) + '/s'
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Network interfaces
app.get('/api/network', async (req, res) => {
  try {
    const [ifaces, stats] = await Promise.all([
      si.networkInterfaces(),
      si.networkStats()
    ]);

    res.json({
      hostname: os.hostname(),
      interfaces: ifaces.map(i => ({
        name: i.iface,
        ip4: i.ip4,
        ip6: i.ip6,
        mac: i.mac,
        speed_mbps: i.speed,
        type: i.type
      })),
      stats: stats.map(s => ({
        interface: s.iface,
        rx_bytes: formatBytes(s.rx_bytes),
        tx_bytes: formatBytes(s.tx_bytes),
        rx_sec: formatBytes(s.rx_sec) + '/s',
        tx_sec: formatBytes(s.tx_sec) + '/s'
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Process list (top 10 by CPU)
app.get('/api/processes', async (req, res) => {
  try {
    const procs = await si.processes();
    const top10 = procs.list
      .sort((a, b) => b.cpu - a.cpu)
      .slice(0, 10)
      .map(p => ({
        pid: p.pid,
        name: p.name,
        cpu_percent: p.cpu.toFixed(2),
        mem_percent: p.mem.toFixed(2),
        state: p.state,
        started: p.started
      }));

    res.json({
      hostname: os.hostname(),
      total_processes: procs.all,
      running: procs.running,
      sleeping: procs.sleeping,
      top10_by_cpu: top10
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dashboard — all in one
app.get('/api/dashboard', async (req, res) => {
  try {
    const [load, mem, disk, net] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.networkStats()
    ]);

    res.json({
      hostname: os.hostname(),
      timestamp: new Date().toISOString(),
      uptime: formatUptime(os.uptime()),
      cpu_load: load.currentLoad.toFixed(2) + '%',
      memory: {
        used_percent: ((mem.used / mem.total) * 100).toFixed(2) + '%',
        free: formatBytes(mem.free)
      },
      disk: disk[0] ? {
        used_percent: disk[0].use.toFixed(2) + '%',
        free: formatBytes(disk[0].available)
      } : null,
      network: net[0] ? {
        rx: formatBytes(net[0].rx_sec) + '/s',
        tx: formatBytes(net[0].tx_sec) + '/s'
      } : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 404
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    available_endpoints: ['/health', '/api/system', '/api/cpu', '/api/memory', '/api/disk', '/api/network', '/api/processes', '/api/dashboard']
  });
});

// Helpers
function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[${new Date().toISOString()}] sysmon listening on 127.0.0.1:${PORT}`);
  // Write startup to log file for CloudWatch
  const fs = require('fs');
  fs.appendFileSync('/var/log/app.log', `[${new Date().toISOString()}] App started on port ${PORT}\n`);
});
