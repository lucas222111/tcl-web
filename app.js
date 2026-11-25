import {
  deleteBinaryFile,
  fetchAndCacheBinary,
  getMeta,
  getStorageCapabilities,
  hasBinaryFile,
  loadBinaryFile,
  requestPersistence,
  saveBinaryFile,
  setMeta,
} from './storage.js';
import { createExt2DiskImage, Ext2Volume } from './ext2.js';
import { GUEST_SCRIPTS } from './vm-scripts.js';

const ASSETS = {
  wasm: {
    key: 'v86-0.5.476.wasm',
    url: 'https://cdn.jsdelivr.net/npm/v86@0.5.476/build/v86.wasm',
    label: 'v86 WebAssembly engine',
  },
  bios: {
    key: 'seabios.bin',
    url: 'https://cdn.jsdelivr.net/gh/copy/v86@master/bios/seabios.bin',
    label: 'SeaBIOS ROM',
  },
  vgaBios: {
    key: 'vgabios.bin',
    url: 'https://cdn.jsdelivr.net/gh/copy/v86@master/bios/vgabios.bin',
    label: 'VGA BIOS ROM',
  },
  tinycoreIso: {
    key: 'tinycore-11.0.iso',
    url: 'https://i.copy.sh/TinyCore-11.0.iso',
    label: 'TinyCore-11.0.iso',
  },
};

const STORAGE_KEYS = {
  disk: 'hda-ext2.img',
  snapshot: 'vm-state.bin',
  customIso: 'custom-boot.iso',
  settings: 'vm-settings',
  customIsoName: 'custom-iso-name',
};

const DEFAULT_SETTINGS = {
  ramMb: 512,
  diskSizeMb: 384,
  relayUrl: 'wisps://wisp.mercurywork.shop/v86/',
  nicType: 'ne2k',
};

const el = {
  announcer: document.getElementById('status-announcer'),
  fileProtocolWarning: document.getElementById('file-protocol-warning'),
  vmStatePill: document.getElementById('vm-state-pill'),
  storageBackendPill: document.getElementById('storage-backend-pill'),
  diskSyncPill: document.getElementById('disk-sync-pill'),
  quotaUsageText: document.getElementById('quota-usage-text'),
  persistStatusText: document.getElementById('persist-status-text'),
  diskMetaText: document.getElementById('disk-meta-text'),
  cacheMetaText: document.getElementById('cache-meta-text'),

  btnBoot: document.getElementById('btn-boot'),
  btnPause: document.getElementById('btn-pause'),
  btnRestart: document.getElementById('btn-restart'),
  btnSaveSnapshot: document.getElementById('btn-save-snapshot'),
  btnRestoreSnapshot: document.getElementById('btn-restore-snapshot'),
  btnSettings: document.getElementById('btn-settings'),
  btnGuide: document.getElementById('btn-guide'),
  btnLockMouse: document.getElementById('btn-lock-mouse'),
  btnCad: document.getElementById('btn-cad'),
  btnFullscreen: document.getElementById('btn-fullscreen'),
  scaleSelect: document.getElementById('scale-select'),

  screenContainer: document.getElementById('screen_container'),
  bootOverlay: document.getElementById('boot-overlay'),
  bootStatusText: document.getElementById('boot-status-text'),
  bootProgress: document.getElementById('boot-progress'),
  btnOverlayBoot: document.getElementById('btn-overlay-boot'),
  btnOverlayRestore: document.getElementById('btn-overlay-restore'),

  cmdForm: document.getElementById('cmd-form'),
  guestCmdInput: document.getElementById('guest-cmd-input'),
  btnSendCmd: document.getElementById('btn-send-cmd'),
  macroButtons: Array.from(document.querySelectorAll('.macro-btn')),
  activityLog: document.getElementById('activity-log'),
  btnClearLog: document.getElementById('btn-clear-log'),

  btnOpenReset: document.getElementById('btn-open-reset'),
  btnSyncDisk: document.getElementById('btn-sync-disk'),
  btnExportDisk: document.getElementById('btn-export-disk'),
  btnImportDisk: document.getElementById('btn-import-disk'),
  importDiskInput: document.getElementById('import-disk-input'),

  btnRefreshFiles: document.getElementById('btn-refresh-files'),
  fileDropzone: document.getElementById('file-dropzone'),
  injectTargetDir: document.getElementById('inject-target-dir'),
  btnChooseFiles: document.getElementById('btn-choose-files'),
  injectFileInput: document.getElementById('inject-file-input'),
  liveDiskWarning: document.getElementById('live-disk-warning'),
  btnStopToEdit: document.getElementById('btn-stop-to-edit'),
  folderTabs: Array.from(document.querySelectorAll('.tab-btn')),
  diskFileList: document.getElementById('disk-file-list'),

  settingsDialog: document.getElementById('settings-dialog'),
  settingsForm: document.getElementById('settings-form'),
  btnCloseSettings: document.getElementById('btn-close-settings'),
  ramSelect: document.getElementById('ram-select'),
  diskSizeSelect: document.getElementById('disk-size-select'),
  netRelaySelect: document.getElementById('net-relay-select'),
  nicTypeSelect: document.getElementById('nic-type-select'),
  customIsoInput: document.getElementById('custom-iso-input'),
  customIsoStatus: document.getElementById('custom-iso-status'),
  btnClearCustomIso: document.getElementById('btn-clear-custom-iso'),

  guideDialog: document.getElementById('guide-dialog'),
  btnCloseGuide: document.getElementById('btn-close-guide'),

  resetDialog: document.getElementById('reset-dialog'),
  resetClearCache: document.getElementById('reset-clear-cache'),
};

const state = {
  settings: structuredClone(DEFAULT_SETTINGS),
  emulator: null,
  vmStatus: 'idle', // idle | loading | running | paused | error
  diskBuffer: null,
  diskDirty: false,
  diskSaveTimer: null,
  restoredFromSnapshot: false,
  wasmBlobUrl: null,
  currentFolder: '/apps',
  customIsoName: null,
  logLines: [],
};

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function sanitizeFileName(name) {
  const base = name.split(/[/\\]/).pop() || 'file.bin';
  const clean = base.replace(/[\x00-\x1f]/g, '_').trim();
  const encoded = utf8Encoder.encode(clean);
  if (encoded.byteLength <= 240) return clean || 'file.bin';
  return utf8Decoder.decode(encoded.subarray(0, 240));
}

function appendLog(message) {
  const stamp = new Date().toLocaleTimeString([], { hour12: false });
  state.logLines.push(`[${stamp}] ${message}`);
  if (state.logLines.length > 150) {
    state.logLines = state.logLines.slice(-150);
  }
  const code = document.createElement('code');
  code.textContent = state.logLines.join('\n');
  el.activityLog.replaceChildren(code);
  el.activityLog.scrollTop = el.activityLog.scrollHeight;
}

function announce(message) {
  el.announcer.textContent = message;
}

function setVmStatus(nextStatus, label) {
  state.vmStatus = nextStatus;
  el.vmStatePill.dataset.state = nextStatus;
  el.vmStatePill.textContent = label;
  syncControlStates();
}

function syncControlStates() {
  const hasEmulator = Boolean(state.emulator);
  const isRunning = state.vmStatus === 'running';
  const isPaused = state.vmStatus === 'paused';
  const isBusy = state.vmStatus === 'loading';

  el.btnBoot.disabled = isBusy || hasEmulator;
  el.btnOverlayBoot.disabled = isBusy || hasEmulator;
  el.btnPause.disabled = !hasEmulator || isBusy;
  el.btnPause.textContent = isPaused ? 'Resume' : 'Pause';
  el.btnRestart.disabled = !hasEmulator || isBusy;
  el.btnSaveSnapshot.disabled = !hasEmulator || isBusy;
  el.btnLockMouse.disabled = !isRunning;
  el.btnCad.disabled = !isRunning;
  el.btnFullscreen.disabled = !hasEmulator;

  el.guestCmdInput.disabled = !isRunning;
  el.btnSendCmd.disabled = !isRunning;
  for (const btn of el.macroButtons) {
    btn.disabled = !isRunning;
  }

  const hasDisk = Boolean(state.diskBuffer);
  el.btnSyncDisk.disabled = !hasDisk || isBusy;
  el.btnExportDisk.disabled = !hasDisk || isBusy;
  el.liveDiskWarning.hidden = !isRunning;
}

/**
 * Seed default helper scripts and directories onto a newly formatted ext2 disk.
 */
function buildSeededExt2Disk(sizeMiB) {
  const buffer = createExt2DiskImage(sizeMiB);
  const fs = new Ext2Volume(buffer);
  fs.ensureDirectory('/tce/optional', 0o777);
  fs.ensureDirectory('/apps', 0o777);
  fs.ensureDirectory('/wineprefix', 0o777);

  for (const [name, content] of Object.entries(GUEST_SCRIPTS)) {
    const mode = name.endsWith('.sh') ? 0o755 : 0o644;
    fs.writeFile(`/apps/${name}`, utf8Encoder.encode(content), mode);
  }
  return buffer;
}

/**
 * Ensure diskBuffer exists in memory (loading from browser storage or formatting fresh).
 */
async function ensureDiskLoaded() {
  if (state.diskBuffer) return state.diskBuffer;

  const stored = await loadBinaryFile(STORAGE_KEYS.disk);
  if (stored) {
    try {
      new Ext2Volume(stored); // validate MBR + ext2 magic
      state.diskBuffer = stored;
      el.diskSyncPill.textContent = 'Disk: loaded from browser';
      appendLog(`Loaded saved ext2 virtual disk (${formatBytes(stored.byteLength)}).`);
      return state.diskBuffer;
    } catch (err) {
      appendLog(`Saved disk validation failed (${err.message}); creating fresh ext2 image.`);
    }
  }

  appendLog(`Formatting fresh ${state.settings.diskSizeMb} MB MBR+ext2 disk in browser…`);
  state.diskBuffer = buildSeededExt2Disk(state.settings.diskSizeMb);
  const backend = await saveBinaryFile(STORAGE_KEYS.disk, state.diskBuffer);
  el.diskSyncPill.textContent = `Disk: saved (${backend})`;
  appendLog(`Formatted & saved ${state.settings.diskSizeMb} MB ext2 disk in ${backend}.`);
  return state.diskBuffer;
}

/**
 * Extract the IDE hda buffer out of a v86 state image if the VM restored from snapshot.
 */
function extractDiskFromStateBuffer(snapshotBuffer, expectedByteLength) {
  const view = new Int32Array(snapshotBuffer, 0, 4);
  const STATE_MAGIC = 0x86768676 | 0;
  if (view[0] !== STATE_MAGIC) return null;

  const infoLen = view[3];
  const infoBytes = new Uint8Array(snapshotBuffer, 16, infoLen);
  const info = JSON.parse(utf8Decoder.decode(infoBytes));
  const bufferBlockStart = (16 + infoLen + 3) & ~3;

  for (const desc of info.buffer_infos || []) {
    if (desc.length === expectedByteLength) {
      const start = bufferBlockStart + desc.offset;
      const slice = new Uint8Array(snapshotBuffer, start, desc.length);
      if (slice[510] === 0x55 && slice[511] === 0xaa) {
        return slice.slice().buffer;
      }
    }
  }
  return null;
}

async function syncDiskToBrowserStorage() {
  if (!state.diskBuffer) return;

  if (state.emulator && state.restoredFromSnapshot) {
    const snap = await state.emulator.save_state();
    const extracted = extractDiskFromStateBuffer(snap, state.diskBuffer.byteLength);
    if (extracted) {
      state.diskBuffer = extracted;
    }
  }

  const backend = await saveBinaryFile(STORAGE_KEYS.disk, state.diskBuffer);
  state.diskDirty = false;
  el.diskSyncPill.textContent = `Disk: synced (${backend})`;
  await refreshStorageSummary();
  renderDiskFileList();
}

function scheduleDiskAutosave() {
  state.diskDirty = true;
  el.diskSyncPill.textContent = 'Disk: unsaved changes';
  if (state.diskSaveTimer) clearTimeout(state.diskSaveTimer);
  state.diskSaveTimer = setTimeout(() => {
    state.diskSaveTimer = null;
    syncDiskToBrowserStorage().catch((err) => {
      appendLog(`Auto-save error: ${err.message}`);
    });
  }, 4000);
}

async function refreshStorageSummary() {
  const caps = await getStorageCapabilities();
  el.storageBackendPill.textContent = `Storage: ${caps.backend}`;

  if (caps.quota > 0) {
    el.quotaUsageText.textContent = `${formatBytes(caps.usage)} / ${formatBytes(caps.quota)}`;
  } else {
    el.quotaUsageText.textContent = `${formatBytes(caps.usage)} used`;
  }

  el.persistStatusText.textContent = caps.persisted
    ? 'Locked (persistent)'
    : 'Best-effort (click Boot to request lock)';

  const diskBytes = state.diskBuffer
    ? state.diskBuffer.byteLength
    : await hasBinaryFile(STORAGE_KEYS.disk);

  if (diskBytes > 0 && state.diskBuffer) {
    try {
      const fs = new Ext2Volume(state.diskBuffer);
      const stats = fs.getStats();
      el.diskMetaText.textContent = `${formatBytes(diskBytes)} (${formatBytes(stats.freeBytes)} free)`;
    } catch {
      el.diskMetaText.textContent = formatBytes(diskBytes);
    }
  } else if (diskBytes > 0) {
    el.diskMetaText.textContent = `${formatBytes(diskBytes)} stored`;
  } else {
    el.diskMetaText.textContent = `Pending (${state.settings.diskSizeMb} MB on boot)`;
  }

  const [isoSize, wasmSize, snapSize, customIsoSize] = await Promise.all([
    hasBinaryFile(ASSETS.tinycoreIso.key),
    hasBinaryFile(ASSETS.wasm.key),
    hasBinaryFile(STORAGE_KEYS.snapshot),
    hasBinaryFile(STORAGE_KEYS.customIso),
  ]);

  const cachedParts = [];
  if (customIsoSize > 0) cachedParts.push(`Custom ISO (${formatBytes(customIsoSize)})`);
  else if (isoSize > 0) cachedParts.push(`TinyCore (${formatBytes(isoSize)})`);
  if (wasmSize > 0) cachedParts.push(`Wasm (${formatBytes(wasmSize)})`);
  el.cacheMetaText.textContent = cachedParts.length ? cachedParts.join(', ') : 'Not cached yet';

  const hasSnap = snapSize > 0;
  el.btnRestoreSnapshot.disabled = !hasSnap || state.vmStatus === 'loading';
  el.btnOverlayRestore.hidden = !hasSnap || Boolean(state.emulator);
}

function renderDiskFileList() {
  const list = el.diskFileList;
  if (!state.diskBuffer) {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.textContent = 'Virtual disk is not initialized yet.';
    list.replaceChildren(li);
    return;
  }

  let entries = [];
  try {
    const fs = new Ext2Volume(state.diskBuffer);
    entries = fs
      .listDirectory(state.currentFolder)
      .toSorted((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.textContent = `Could not read ${state.currentFolder}: ${err.message}`;
    list.replaceChildren(li);
    return;
  }

  if (entries.length === 0) {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.textContent = `No files in ${state.currentFolder} yet.`;
    list.replaceChildren(li);
    return;
  }

  const items = entries.map((entry) => {
    const li = document.createElement('li');
    li.className = 'file-item';

    const meta = document.createElement('div');
    meta.className = 'file-meta';

    const nameEl = document.createElement('span');
    nameEl.className = 'file-name';
    nameEl.textContent = entry.isDir ? `${entry.name}/` : entry.name;

    const sizeEl = document.createElement('span');
    sizeEl.className = 'file-size';
    sizeEl.textContent = entry.isDir ? 'Directory' : formatBytes(entry.size);

    meta.append(nameEl, sizeEl);

    const actions = document.createElement('div');
    actions.className = 'file-actions';

    if (!entry.isDir) {
      if (/\.exe$|\.msi$/i.test(entry.name) && state.currentFolder === '/apps') {
        const runBtn = document.createElement('button');
        runBtn.type = 'button';
        runBtn.className = 'btn btn-sm btn-primary';
        runBtn.textContent = 'Run';
        runBtn.disabled = state.vmStatus !== 'running';
        runBtn.addEventListener('click', () => {
          sendCommandToGuest(`sh /mnt/sda1/apps/run-win.sh '/mnt/sda1/apps/${entry.name}'`);
        });
        actions.append(runBtn);
      }

      const dlBtn = document.createElement('button');
      dlBtn.type = 'button';
      dlBtn.className = 'btn btn-sm';
      dlBtn.textContent = 'Get';
      dlBtn.addEventListener('click', () => downloadFileFromExt2(`${state.currentFolder}/${entry.name}`, entry.name));

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn-sm btn-danger';
      delBtn.textContent = 'Del';
      delBtn.disabled = state.vmStatus === 'running';
      delBtn.addEventListener('click', () => deleteFileFromExt2(`${state.currentFolder}/${entry.name}`));

      actions.append(dlBtn, delBtn);
    }

    li.append(meta, actions);
    return li;
  });

  list.replaceChildren(...items);
}

function downloadBlob(filename, data) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function downloadFileFromExt2(fullPath, fileName) {
  if (!state.diskBuffer) return;
  try {
    const fs = new Ext2Volume(state.diskBuffer);
    const bytes = fs.readFile(fullPath);
    downloadBlob(fileName, bytes);
    appendLog(`Exported ${fullPath} (${formatBytes(bytes.byteLength)}) to host.`);
  } catch (err) {
    appendLog(`Export failed: ${err.message}`);
  }
}

async function deleteFileFromExt2(fullPath) {
  if (state.vmStatus === 'running') {
    appendLog('Stop the VM before modifying the ext2 filesystem from the host.');
    return;
  }
  await ensureDiskLoaded();
  const fs = new Ext2Volume(state.diskBuffer);
  fs.deleteFile(fullPath);
  await syncDiskToBrowserStorage();
  appendLog(`Deleted ${fullPath} from virtual ext2 disk.`);
}

async function injectFilesIntoExt2(fileList) {
  if (!fileList || fileList.length === 0) return;

  if (state.vmStatus === 'running') {
    appendLog('Blocked host ext2 write while VM is running. Stop the VM first to avoid disk corruption.');
    announce('Stop the VM before adding files to the virtual hard drive.');
    return;
  }

  await ensureDiskLoaded();
  const targetDir = el.injectTargetDir.value || '/apps';
  const fs = new Ext2Volume(state.diskBuffer);

  for (const file of fileList) {
    const cleanName = sanitizeFileName(file.name);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const targetPath = `${targetDir}/${cleanName}`;
    const mode = /\.sh$/i.test(cleanName) ? 0o755 : 0o644;
    fs.writeFile(targetPath, bytes, mode);
    appendLog(`Injected ${targetPath} (${formatBytes(bytes.byteLength)}) onto ext2 virtual drive.`);
  }

  await syncDiskToBrowserStorage();
  state.currentFolder = targetDir;
  for (const tab of el.folderTabs) {
    tab.setAttribute('aria-pressed', String(tab.dataset.folder === targetDir));
  }
  renderDiskFileList();
  announce(`Added ${fileList.length} file(s) to ${targetDir}.`);
}

async function prepareBootAssets() {
  el.bootProgress.hidden = false;
  el.bootProgress.value = 0;

  const updateProgress = (label, { loaded, total, fromCache }) => {
    const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    el.bootProgress.value = pct;
    const sourceText = fromCache ? 'from browser storage' : `${formatBytes(loaded)} / ${formatBytes(total)}`;
    el.bootStatusText.textContent = `Loading ${label} (${sourceText})…`;
  };

  const signal = AbortSignal.timeout(120_000);

  const [wasmBuf, biosBuf, vgaBiosBuf] = await Promise.all([
    fetchAndCacheBinary(ASSETS.wasm.key, ASSETS.wasm.url, (p) => updateProgress(ASSETS.wasm.label, p), signal),
    fetchAndCacheBinary(ASSETS.bios.key, ASSETS.bios.url, (p) => updateProgress(ASSETS.bios.label, p), signal),
    fetchAndCacheBinary(ASSETS.vgaBios.key, ASSETS.vgaBios.url, (p) => updateProgress(ASSETS.vgaBios.label, p), signal),
  ]);

  let isoBuf = await loadBinaryFile(STORAGE_KEYS.customIso);
  let isoLabel = state.customIsoName || 'Custom ISO';
  if (!isoBuf) {
    isoLabel = ASSETS.tinycoreIso.label;
    isoBuf = await fetchAndCacheBinary(
      ASSETS.tinycoreIso.key,
      ASSETS.tinycoreIso.url,
      (p) => updateProgress(ASSETS.tinycoreIso.label, p),
      signal,
    );
  } else {
    updateProgress(isoLabel, { loaded: isoBuf.byteLength, total: isoBuf.byteLength, fromCache: true });
  }

  return { wasmBuf, biosBuf, vgaBiosBuf, isoBuf, isoLabel };
}

async function bootVm({ restoreSnapshot = false } = {}) {
  if (state.emulator) return;
  if (typeof window.V86 !== 'function') {
    setVmStatus('error', 'Error: v86 missing');
    appendLog('libv86.js failed to load from jsDelivr CDN.');
    return;
  }

  setVmStatus('loading', 'Preparing assets…');
  el.bootOverlay.hidden = false;

  try {
    const granted = await requestPersistence();
    if (granted) {
      appendLog('Browser granted persistent storage lock.');
    }

    await ensureDiskLoaded();
    const { wasmBuf, biosBuf, vgaBiosBuf, isoBuf, isoLabel } = await prepareBootAssets();

    if (state.wasmBlobUrl) {
      URL.revokeObjectURL(state.wasmBlobUrl);
    }
    state.wasmBlobUrl = URL.createObjectURL(new Blob([wasmBuf], { type: 'application/wasm' }));

    let snapshotBuf = null;
    if (restoreSnapshot) {
      snapshotBuf = await loadBinaryFile(STORAGE_KEYS.snapshot);
      if (!snapshotBuf) {
        appendLog('No saved VM snapshot found; performing clean boot.');
      }
    }

    el.bootStatusText.textContent = `Starting x86 emulator with ${isoLabel} (${state.settings.ramMb} MB RAM)…`;
    appendLog(`Starting v86 (${state.settings.ramMb} MB RAM, NIC: ${state.settings.nicType}, ISO: ${isoLabel})…`);

    const v86Config = {
      wasm_path: state.wasmBlobUrl,
      memory_size: state.settings.ramMb * 1024 * 1024,
      vga_memory_size: 16 * 1024 * 1024,
      screen_container: el.screenContainer,
      bios: { buffer: biosBuf.slice(0) },
      vga_bios: { buffer: vgaBiosBuf.slice(0) },
      cdrom: { buffer: isoBuf.slice(0) },
      hda: { buffer: state.diskBuffer },
      boot_order: 0x123, // CD-ROM first, then persistent ext2 hard drive (hda)
      filesystem: {}, // 9p share for compatible guests
      autostart: !snapshotBuf,
    };

    if (state.settings.relayUrl) {
      v86Config.net_device = {
        type: state.settings.nicType || 'ne2k',
        relay_url: state.settings.relayUrl,
      };
    }

    const emulator = new window.V86(v86Config);
    state.emulator = emulator;
    state.restoredFromSnapshot = Boolean(snapshotBuf);

    emulator.add_listener('ide-write-end', () => {
      scheduleDiskAutosave();
    });

    emulator.add_listener('emulator-ready', async () => {
      try {
        if (snapshotBuf) {
          el.bootStatusText.textContent = 'Restoring saved RAM + CPU snapshot…';
          await emulator.restore_state(snapshotBuf);
          await emulator.run();
          appendLog('Snapshot restored from browser storage.');
        } else {
          appendLog('Tiny Core Linux booting. Click screen for mouse capture; use macros once desktop/aterm opens.');
        }
        el.bootOverlay.hidden = true;
        setVmStatus('running', 'Running');
        applyDisplayScale();
        await refreshStorageSummary();
        renderDiskFileList();
        announce('Tiny Core Linux virtual machine is running.');
      } catch (err) {
        setVmStatus('error', 'Restore failed');
        el.bootOverlay.hidden = false;
        el.bootStatusText.textContent = `VM start error: ${err.message}`;
        appendLog(`VM startup error: ${err.message}`);
      }
    });
  } catch (err) {
    setVmStatus('error', 'Boot failed');
    el.bootOverlay.hidden = false;
    el.bootProgress.hidden = true;
    el.bootStatusText.textContent = `Boot failed: ${err.message}`;
    appendLog(`Boot error: ${err.message}`);
  }
}

async function stopAndDestroyVm() {
  if (!state.emulator) return;
  if (state.diskSaveTimer) {
    clearTimeout(state.diskSaveTimer);
    state.diskSaveTimer = null;
  }

  try {
    await state.emulator.stop();
    await syncDiskToBrowserStorage();
    await state.emulator.destroy();
  } catch (err) {
    appendLog(`Stop warning: ${err.message}`);
  }

  state.emulator = null;
  state.restoredFromSnapshot = false;
  el.bootOverlay.hidden = false;
  el.bootProgress.hidden = true;
  el.bootStatusText.textContent = 'VM stopped. Edit files in the ext2 File Bridge or start again.';
  setVmStatus('idle', 'Stopped');
  renderDiskFileList();
  await refreshStorageSummary();
  appendLog('VM stopped and persistent virtual disk synced to browser storage.');
}

function sendCommandToGuest(cmd) {
  if (!state.emulator || state.vmStatus !== 'running') {
    appendLog('Cannot send command: VM is not running.');
    return;
  }
  const clean = cmd.trim();
  if (!clean) return;
  state.emulator.keyboard_send_text(`${clean}\n`);
  appendLog(`Sent command to guest keyboard: ${clean}`);
}

function applyDisplayScale() {
  if (!state.emulator) return;
  const factor = Number(el.scaleSelect.value) || 1;
  state.emulator.screen_set_scale(factor, factor);
}

function wireLightDismissFallback() {
  if ('closedBy' in HTMLDialogElement.prototype) return;
  const outside = (e, dialog) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => {
      pressedOutside = outside(e, dialog);
    });
    dialog.addEventListener('pointerup', (e) => {
      if (pressedOutside && outside(e, dialog)) dialog.close();
    });
  }
}

function bindEvents() {
  el.btnBoot.addEventListener('click', () => bootVm({ restoreSnapshot: false }));
  el.btnOverlayBoot.addEventListener('click', () => bootVm({ restoreSnapshot: false }));
  el.btnOverlayRestore.addEventListener('click', () => bootVm({ restoreSnapshot: true }));
  el.btnRestoreSnapshot.addEventListener('click', async () => {
    if (state.emulator) {
      const snap = await loadBinaryFile(STORAGE_KEYS.snapshot);
      if (!snap) return;
      await state.emulator.stop();
      await state.emulator.restore_state(snap);
      state.restoredFromSnapshot = true;
      await state.emulator.run();
      setVmStatus('running', 'Running');
      appendLog('Restored saved VM snapshot.');
    } else {
      await bootVm({ restoreSnapshot: true });
    }
  });

  el.btnPause.addEventListener('click', async () => {
    if (!state.emulator) return;
    if (state.vmStatus === 'running') {
      await state.emulator.stop();
      await syncDiskToBrowserStorage();
      setVmStatus('paused', 'Paused');
      appendLog('VM paused and disk synced.');
    } else if (state.vmStatus === 'paused') {
      await state.emulator.run();
      setVmStatus('running', 'Running');
      appendLog('VM resumed.');
    }
  });

  el.btnRestart.addEventListener('click', () => {
    if (!state.emulator) return;
    state.emulator.restart();
    appendLog('Sent hardware reset signal to VM.');
  });

  el.btnSaveSnapshot.addEventListener('click', async () => {
    if (!state.emulator) return;
    appendLog('Capturing full RAM + CPU + disk snapshot to browser storage…');
    const wasRunning = state.vmStatus === 'running';
    if (wasRunning) await state.emulator.stop();
    const snap = await state.emulator.save_state();
    await saveBinaryFile(STORAGE_KEYS.snapshot, snap);
    await syncDiskToBrowserStorage();
    if (wasRunning) await state.emulator.run();
    await refreshStorageSummary();
    appendLog(`Saved VM snapshot (${formatBytes(snap.byteLength)}).`);
    announce('Virtual machine snapshot saved.');
  });

  el.btnStopToEdit.addEventListener('click', () => stopAndDestroyVm());

  el.btnLockMouse.addEventListener('click', () => {
    if (!state.emulator || state.vmStatus !== 'running') return;
    try {
      state.emulator.lock_mouse();
    } catch (err) {
      appendLog(`Pointer lock unavailable: ${err.message}`);
    }
  });

  document.addEventListener('pointerlockerror', () => {
    appendLog('Pointer lock was blocked by the browser environment.');
  });

  el.scaleSelect.addEventListener('change', applyDisplayScale);

  el.btnFullscreen.addEventListener('click', () => {
    if (state.emulator) state.emulator.screen_go_fullscreen();
  });

  el.btnCad.addEventListener('click', () => {
    if (!state.emulator) return;
    // Left Ctrl (0x1d), Left Alt (0x38), Delete (0xe0 0x53) make/break scan codes
    state.emulator.keyboard_send_scancodes([
      0x1d, 0x38, 0xe0, 0x53,
      0xe0, 0xd3, 0xb8, 0x9d,
    ]);
    appendLog('Sent Ctrl+Alt+Del scan codes.');
  });

  for (const btn of el.macroButtons) {
    btn.addEventListener('click', () => {
      if (btn.dataset.cmd) sendCommandToGuest(btn.dataset.cmd);
    });
  }

  el.cmdForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const cmd = el.guestCmdInput.value;
    if (!cmd.trim()) return;
    sendCommandToGuest(cmd);
    el.guestCmdInput.value = '';
  });

  el.btnClearLog.addEventListener('click', () => {
    state.logLines = [];
    el.activityLog.replaceChildren(document.createElement('code'));
  });

  el.btnSyncDisk.addEventListener('click', async () => {
    await syncDiskToBrowserStorage();
    appendLog('Synced ext2 disk buffer to browser storage.');
  });

  el.btnExportDisk.addEventListener('click', () => {
    if (!state.diskBuffer) return;
    downloadBlob('tinycore-hda-ext2.img', state.diskBuffer);
    appendLog(`Exported raw virtual hard disk (${formatBytes(state.diskBuffer.byteLength)}).`);
  });

  el.btnImportDisk.addEventListener('click', () => el.importDiskInput.click());

  el.importDiskInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (state.emulator) {
      await stopAndDestroyVm();
    }
    const buf = await file.arrayBuffer();
    try {
      new Ext2Volume(buf);
    } catch (err) {
      appendLog(`Rejected disk import: ${err.message}`);
      return;
    }
    state.diskBuffer = buf;
    await saveBinaryFile(STORAGE_KEYS.disk, buf);
    el.diskSyncPill.textContent = 'Disk: imported & saved';
    await refreshStorageSummary();
    renderDiskFileList();
    appendLog(`Imported ext2 disk image (${formatBytes(buf.byteLength)}).`);
  });

  el.btnRefreshFiles.addEventListener('click', () => renderDiskFileList());

  for (const tab of el.folderTabs) {
    tab.addEventListener('click', () => {
      state.currentFolder = tab.dataset.folder;
      for (const t of el.folderTabs) {
        t.setAttribute('aria-pressed', String(t === tab));
      }
      renderDiskFileList();
    });
  }

  el.btnChooseFiles.addEventListener('click', () => el.injectFileInput.click());

  el.injectFileInput.addEventListener('change', async (e) => {
    await injectFilesIntoExt2(e.target.files);
    e.target.value = '';
  });

  el.fileDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.fileDropzone.classList.add('is-dragover');
  });

  el.fileDropzone.addEventListener('dragleave', () => {
    el.fileDropzone.classList.remove('is-dragover');
  });

  el.fileDropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    el.fileDropzone.classList.remove('is-dragover');
    await injectFilesIntoExt2(e.dataTransfer?.files);
  });

  // Settings Modal
  el.btnSettings.addEventListener('click', () => {
    el.ramSelect.value = String(state.settings.ramMb);
    el.diskSizeSelect.value = String(state.settings.diskSizeMb);
    el.netRelaySelect.value = state.settings.relayUrl;
    el.nicTypeSelect.value = state.settings.nicType;
    el.customIsoStatus.textContent = state.customIsoName
      ? `Using cached custom ISO: ${state.customIsoName}`
      : 'Using built-in TinyCore-11.0.iso (~19 MB).';
    el.btnClearCustomIso.hidden = !state.customIsoName;
    el.settingsDialog.showModal();
  });

  el.btnCloseSettings.addEventListener('click', () => {
    el.settingsDialog.close('cancel');
  });

  el.customIsoInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const buf = await file.arrayBuffer();
    await saveBinaryFile(STORAGE_KEYS.customIso, buf);
    await setMeta(STORAGE_KEYS.customIsoName, file.name);
    state.customIsoName = file.name;
    el.customIsoStatus.textContent = `Cached custom ISO: ${file.name} (${formatBytes(buf.byteLength)})`;
    el.btnClearCustomIso.hidden = false;
    await refreshStorageSummary();
    appendLog(`Cached custom boot ISO ${file.name} in browser storage.`);
  });

  el.btnClearCustomIso.addEventListener('click', async () => {
    await deleteBinaryFile(STORAGE_KEYS.customIso);
    await setMeta(STORAGE_KEYS.customIsoName, null);
    state.customIsoName = null;
    el.customIsoStatus.textContent = 'Using built-in TinyCore-11.0.iso (~19 MB).';
    el.btnClearCustomIso.hidden = true;
    await refreshStorageSummary();
    appendLog('Reverted to default TinyCore-11.0.iso.');
  });

  el.settingsDialog.addEventListener('close', async () => {
    const val = el.settingsDialog.returnValue;
    el.settingsDialog.returnValue = '';
    if (val === 'save') {
      state.settings = {
        ramMb: Number(el.ramSelect.value) || 512,
        diskSizeMb: Number(el.diskSizeSelect.value) || 384,
        relayUrl: el.netRelaySelect.value,
        nicType: el.nicTypeSelect.value || 'ne2k',
      };
      await setMeta(STORAGE_KEYS.settings, state.settings);
      appendLog(
        `Saved settings (${state.settings.ramMb} MB RAM, ${state.settings.diskSizeMb} MB new-disk size, NIC ${state.settings.nicType}). Restart VM to apply hardware changes.`,
      );
      await refreshStorageSummary();
    }
  });

  // Guide Modal
  el.btnGuide.addEventListener('click', () => el.guideDialog.showModal());
  el.btnCloseGuide.addEventListener('click', () => el.guideDialog.close('close'));
  el.guideDialog.addEventListener('close', () => {
    el.guideDialog.returnValue = '';
  });

  // Reset Modal
  el.btnOpenReset.addEventListener('click', () => {
    el.resetClearCache.checked = false;
    el.resetDialog.showModal();
  });

  el.resetDialog.addEventListener('close', async () => {
    const val = el.resetDialog.returnValue;
    el.resetDialog.returnValue = '';
    if (val !== 'confirm') return;

    if (state.emulator) {
      await stopAndDestroyVm();
    }

    await deleteBinaryFile(STORAGE_KEYS.disk);
    await deleteBinaryFile(STORAGE_KEYS.snapshot);
    if (el.resetClearCache.checked) {
      await Promise.all([
        deleteBinaryFile(ASSETS.tinycoreIso.key),
        deleteBinaryFile(ASSETS.wasm.key),
        deleteBinaryFile(ASSETS.bios.key),
        deleteBinaryFile(ASSETS.vgaBios.key),
        deleteBinaryFile(STORAGE_KEYS.customIso),
      ]);
      await setMeta(STORAGE_KEYS.customIsoName, null);
      state.customIsoName = null;
    }

    state.diskBuffer = null;
    await ensureDiskLoaded();
    await refreshStorageSummary();
    renderDiskFileList();
    appendLog('Reset virtual hard drive and browser storage.');
    announce('Virtual hard drive reformatted.');
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.diskDirty && state.diskBuffer) {
      saveBinaryFile(STORAGE_KEYS.disk, state.diskBuffer).catch(() => {});
      e.preventDefault();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.diskDirty && state.diskBuffer) {
      syncDiskToBrowserStorage().catch(() => {});
    }
  });
}

async function init() {
  if (window.location.protocol === 'file:') {
    el.fileProtocolWarning.hidden = false;
  }

  if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  wireLightDismissFallback();
  bindEvents();

  try {
    const savedSettings = await getMeta(STORAGE_KEYS.settings);
    if (savedSettings && typeof savedSettings === 'object') {
      state.settings = { ...DEFAULT_SETTINGS, ...savedSettings };
    }
    state.customIsoName = await getMeta(STORAGE_KEYS.customIsoName, null);

    await ensureDiskLoaded();
    await refreshStorageSummary();
    renderDiskFileList();
    syncControlStates();
    appendLog('Browser storage ready. Click "Start Emulated PC" to boot Tiny Core Linux 11.0.');
  } catch (err) {
    appendLog(`Initialization error: ${err.message}`);
    setVmStatus('error', 'Init error');
  }
}

init();
