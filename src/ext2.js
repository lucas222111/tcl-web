/**
 * Pure-JavaScript MBR + ext2 (rev 1) filesystem builder, reader, and writer.
 * Allows creating and inspecting real Linux ext2 virtual hard disks directly
 * in the browser without external native tools.
 */

const SECTOR_SIZE = 512;
const PART_START_SECTOR = 2048; // 1 MiB alignment
const PART_OFFSET = PART_START_SECTOR * SECTOR_SIZE;
const BLOCK_SIZE = 4096;
const LOG_BLOCK_SIZE = 2; // 1024 << 2 = 4096
const INODE_SIZE = 128;
const BLOCKS_PER_GROUP = 32768; // 4096 * 8 bits
const INODES_PER_GROUP = 4096;
const INODE_TABLE_BLOCKS = (INODES_PER_GROUP * INODE_SIZE) / BLOCK_SIZE; // 128
const FIRST_NON_RESERVED_INO = 11;
const EXT2_MAGIC = 0xef53;

const FT_REG_FILE = 1;
const FT_DIR = 2;

const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;

const EXT2_FEATURE_INCOMPAT_FILETYPE = 0x0002;
const EXT2_FEATURE_RO_COMPAT_SPARSE_SUPER = 0x0001;

const UID_TC = 1001;
const GID_STAFF = 50;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

function isPowerOf(n, base) {
  if (n < 1) return false;
  let val = n;
  while (val % base === 0) val /= base;
  return val === 1;
}

function groupHasSuperblock(groupIndex) {
  return (
    groupIndex === 0 ||
    groupIndex === 1 ||
    isPowerOf(groupIndex, 3) ||
    isPowerOf(groupIndex, 5) ||
    isPowerOf(groupIndex, 7)
  );
}

function align4(n) {
  return (n + 3) & ~3;
}

function randomUuid() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes;
}

/**
 * Create a formatted MBR + ext2 disk image buffer of `sizeMiB` megabytes.
 */
export function createExt2DiskImage(sizeMiB = 384) {
  const totalBytes = sizeMiB * 1024 * 1024;
  const totalSectors = Math.floor(totalBytes / SECTOR_SIZE);
  const partSectors = totalSectors - PART_START_SECTOR;
  const blocksCount = Math.floor((partSectors * SECTOR_SIZE) / BLOCK_SIZE);

  if (blocksCount < 2048) {
    throw new Error('Disk size too small for ext2 formatting');
  }

  const buffer = new ArrayBuffer(totalBytes);
  const u8 = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // 1. Write MBR partition entry 1 (LBA 2048 .. end, type 0x83 Linux)
  const p0 = 446;
  u8[p0 + 0] = 0x00;
  u8[p0 + 1] = 0x20;
  u8[p0 + 2] = 0x21;
  u8[p0 + 3] = 0x00;
  u8[p0 + 4] = 0x83; // Linux native
  u8[p0 + 5] = 0xfe;
  u8[p0 + 6] = 0xff;
  u8[p0 + 7] = 0xff;
  view.setUint32(p0 + 8, PART_START_SECTOR, true);
  view.setUint32(p0 + 12, partSectors, true);
  u8[510] = 0x55;
  u8[511] = 0xaa;

  // 2. Plan ext2 block groups
  const numGroups = Math.ceil(blocksCount / BLOCKS_PER_GROUP);
  const inodesCount = numGroups * INODES_PER_GROUP;
  const nowSec = Math.floor(Date.now() / 1000);
  const uuid = randomUuid();

  let freeBlocksTotal = 0;
  const freeInodesTotal = inodesCount - (FIRST_NON_RESERVED_INO - 1);

  const bgdtBytes = new Uint8Array(BLOCK_SIZE);
  const bgdtView = new DataView(bgdtBytes.buffer);

  const groupMeta = [];

  for (let g = 0; g < numGroups; g++) {
    const groupStartBlock = g * BLOCKS_PER_GROUP;
    const groupBlockCount = Math.min(BLOCKS_PER_GROUP, blocksCount - groupStartBlock);
    const hasSuper = groupHasSuperblock(g);
    const metaHeaderBlocks = hasSuper ? 2 : 0; // superblock + BGDT
    const blockBitmapRel = metaHeaderBlocks;
    const inodeBitmapRel = metaHeaderBlocks + 1;
    const inodeTableRel = metaHeaderBlocks + 2;
    const dataStartRel = inodeTableRel + INODE_TABLE_BLOCKS;

    if (groupBlockCount <= dataStartRel) {
      throw new Error(`Block group ${g} is too small (${groupBlockCount} blocks)`);
    }

    const usedMetaBlocks = dataStartRel;
    const groupFreeBlocks = groupBlockCount - usedMetaBlocks;
    const groupUsedInodes = g === 0 ? FIRST_NON_RESERVED_INO - 1 : 0;
    const groupFreeInodes = INODES_PER_GROUP - groupUsedInodes;

    freeBlocksTotal += groupFreeBlocks;

    const blockBitmapAbs = groupStartBlock + blockBitmapRel;
    const inodeBitmapAbs = groupStartBlock + inodeBitmapRel;
    const inodeTableAbs = groupStartBlock + inodeTableRel;

    groupMeta.push({
      g,
      groupStartBlock,
      groupBlockCount,
      blockBitmapAbs,
      inodeBitmapAbs,
      inodeTableAbs,
      usedMetaBlocks,
    });

    const descOff = g * 32;
    bgdtView.setUint32(descOff + 0, blockBitmapAbs, true);
    bgdtView.setUint32(descOff + 4, inodeBitmapAbs, true);
    bgdtView.setUint32(descOff + 8, inodeTableAbs, true);
    bgdtView.setUint16(descOff + 12, groupFreeBlocks, true);
    bgdtView.setUint16(descOff + 14, groupFreeInodes, true);
    bgdtView.setUint16(descOff + 16, 0, true); // used dirs count
  }

  // Write superblock helper
  function buildSuperblock(blockGroupNr) {
    const sb = new Uint8Array(1024);
    const sv = new DataView(sb.buffer);
    sv.setUint32(0x00, inodesCount, true);
    sv.setUint32(0x04, blocksCount, true);
    sv.setUint32(0x08, 0, true);
    sv.setUint32(0x0c, freeBlocksTotal, true);
    sv.setUint32(0x10, freeInodesTotal, true);
    sv.setUint32(0x14, 0, true); // s_first_data_block = 0 for 4K blocks
    sv.setUint32(0x18, LOG_BLOCK_SIZE, true);
    sv.setUint32(0x1c, LOG_BLOCK_SIZE, true);
    sv.setUint32(0x20, BLOCKS_PER_GROUP, true);
    sv.setUint32(0x24, BLOCKS_PER_GROUP, true);
    sv.setUint32(0x28, INODES_PER_GROUP, true);
    sv.setUint32(0x2c, 0, true);
    sv.setUint32(0x30, nowSec, true);
    sv.setUint16(0x34, 0, true);
    sv.setUint16(0x36, 0xffff, true);
    sv.setUint16(0x38, EXT2_MAGIC, true);
    sv.setUint16(0x3a, 1, true); // EXT2_VALID_FS
    sv.setUint16(0x3c, 1, true); // EXT2_ERRORS_CONTINUE
    sv.setUint16(0x3e, 0, true);
    sv.setUint32(0x40, nowSec, true);
    sv.setUint32(0x44, 0, true);
    sv.setUint32(0x48, 0, true); // Linux
    sv.setUint32(0x4c, 1, true); // EXT2_DYNAMIC_REV
    sv.setUint16(0x50, 0, true);
    sv.setUint16(0x52, 0, true);
    sv.setUint32(0x54, FIRST_NON_RESERVED_INO, true);
    sv.setUint16(0x58, INODE_SIZE, true);
    sv.setUint16(0x5a, blockGroupNr, true);
    sv.setUint32(0x5c, 0, true);
    sv.setUint32(0x60, EXT2_FEATURE_INCOMPAT_FILETYPE, true);
    sv.setUint32(0x64, EXT2_FEATURE_RO_COMPAT_SPARSE_SUPER, true);
    sb.set(uuid, 0x68);
    sb.set(utf8Encoder.encode('TINYCORE_DISK'), 0x78);
    return sb;
  }

  // Write group bitmaps and backup superblocks/BGDTs
  for (const gm of groupMeta) {
    if (groupHasSuperblock(gm.g)) {
      const sbOff = PART_OFFSET + gm.groupStartBlock * BLOCK_SIZE + (gm.g === 0 ? 1024 : 0);
      u8.set(buildSuperblock(gm.g), sbOff);
      u8.set(bgdtBytes, PART_OFFSET + (gm.groupStartBlock + 1) * BLOCK_SIZE);
    }

    // Block bitmap
    const bbOff = PART_OFFSET + gm.blockBitmapAbs * BLOCK_SIZE;
    for (let b = 0; b < gm.usedMetaBlocks; b++) {
      u8[bbOff + (b >> 3)] |= 1 << (b & 7);
    }
    for (let b = gm.groupBlockCount; b < BLOCKS_PER_GROUP; b++) {
      u8[bbOff + (b >> 3)] |= 1 << (b & 7);
    }

    // Inode bitmap
    const ibOff = PART_OFFSET + gm.inodeBitmapAbs * BLOCK_SIZE;
    if (gm.g === 0) {
      for (let i = 0; i < FIRST_NON_RESERVED_INO - 1; i++) {
        u8[ibOff + (i >> 3)] |= 1 << (i & 7);
      }
    }
    for (let i = INODES_PER_GROUP; i < BLOCK_SIZE * 8; i++) {
      u8[ibOff + (i >> 3)] |= 1 << (i & 7);
    }
  }

  // Initialize root directory (inode 2) using Ext2Volume writer
  const fs = new Ext2Volume(buffer);
  fs.initRootDirectory();
  return buffer;
}

/**
 * Read/write wrapper around an existing MBR + ext2 disk ArrayBuffer.
 */
export class Ext2Volume {
  constructor(buffer) {
    this.buffer = buffer;
    this.u8 = new Uint8Array(buffer);
    this.view = new DataView(buffer);

    if (this.u8[510] !== 0x55 || this.u8[511] !== 0xaa) {
      throw new Error('Invalid MBR signature on virtual disk');
    }

    this.partStartSector = this.view.getUint32(446 + 8, true);
    this.partOffset = this.partStartSector * SECTOR_SIZE;

    const magic = this.view.getUint16(this.partOffset + 1024 + 0x38, true);
    if (magic !== EXT2_MAGIC) {
      throw new Error(`Invalid ext2 superblock magic: 0x${magic.toString(16)}`);
    }

    this.inodesCount = this.view.getUint32(this.partOffset + 1024 + 0x00, true);
    this.blocksCount = this.view.getUint32(this.partOffset + 1024 + 0x04, true);
    this.firstDataBlock = this.view.getUint32(this.partOffset + 1024 + 0x14, true);
    this.blockSize = 1024 << this.view.getUint32(this.partOffset + 1024 + 0x18, true);
    this.blocksPerGroup = this.view.getUint32(this.partOffset + 1024 + 0x20, true);
    this.inodesPerGroup = this.view.getUint32(this.partOffset + 1024 + 0x28, true);
    this.inodeSize = this.view.getUint16(this.partOffset + 1024 + 0x58, true) || 128;
    this.numGroups = Math.ceil(this.blocksCount / this.blocksPerGroup);
    this.bgdtOffset = this.partOffset + (this.firstDataBlock + 1) * this.blockSize;
  }

  blockByteOffset(blockNum) {
    return this.partOffset + blockNum * this.blockSize;
  }

  inodeByteOffset(ino) {
    const idx = ino - 1;
    const g = Math.floor(idx / this.inodesPerGroup);
    const localIdx = idx % this.inodesPerGroup;
    const inodeTableBlock = this.view.getUint32(this.bgdtOffset + g * 32 + 8, true);
    return this.blockByteOffset(inodeTableBlock) + localIdx * this.inodeSize;
  }

  getFreeBlocksCount() {
    return this.view.getUint32(this.partOffset + 1024 + 0x0c, true);
  }

  getFreeInodesCount() {
    return this.view.getUint32(this.partOffset + 1024 + 0x10, true);
  }

  adjustSuperFreeBlocks(delta) {
    const val = this.getFreeBlocksCount() + delta;
    this.view.setUint32(this.partOffset + 1024 + 0x0c, val, true);
    for (let g = 1; g < this.numGroups; g++) {
      if (groupHasSuperblock(g)) {
        const off = this.blockByteOffset(g * this.blocksPerGroup) + 0x0c;
        this.view.setUint32(off, val, true);
      }
    }
  }

  adjustSuperFreeInodes(delta) {
    const val = this.getFreeInodesCount() + delta;
    this.view.setUint32(this.partOffset + 1024 + 0x10, val, true);
    for (let g = 1; g < this.numGroups; g++) {
      if (groupHasSuperblock(g)) {
        const off = this.blockByteOffset(g * this.blocksPerGroup) + 0x10;
        this.view.setUint32(off, val, true);
      }
    }
  }

  syncBackupBgdt(groupIndex) {
    const src = this.bgdtOffset + groupIndex * 32;
    const slice = this.u8.subarray(src, src + 32);
    for (let g = 1; g < this.numGroups; g++) {
      if (groupHasSuperblock(g)) {
        const dst = this.blockByteOffset(g * this.blocksPerGroup + 1) + groupIndex * 32;
        this.u8.set(slice, dst);
      }
    }
  }

  allocBlock(preferredGroup = 0) {
    for (let step = 0; step < this.numGroups; step++) {
      const g = (preferredGroup + step) % this.numGroups;
      const descOff = this.bgdtOffset + g * 32;
      const freeCount = this.view.getUint16(descOff + 12, true);
      if (freeCount === 0) continue;

      const bitmapBlock = this.view.getUint32(descOff + 0, true);
      const bbOff = this.blockByteOffset(bitmapBlock);
      const groupBlocks = Math.min(this.blocksPerGroup, this.blocksCount - g * this.blocksPerGroup);

      for (let b = 0; b < groupBlocks; b++) {
        const byteIdx = bbOff + (b >> 3);
        const mask = 1 << (b & 7);
        if ((this.u8[byteIdx] & mask) === 0) {
          this.u8[byteIdx] |= mask;
          this.view.setUint16(descOff + 12, freeCount - 1, true);
          this.syncBackupBgdt(g);
          this.adjustSuperFreeBlocks(-1);
          const absBlock = g * this.blocksPerGroup + b + this.firstDataBlock;
          this.u8.fill(0, this.blockByteOffset(absBlock), this.blockByteOffset(absBlock) + this.blockSize);
          return absBlock;
        }
      }
    }
    throw new Error('No free blocks left on virtual ext2 disk');
  }

  freeBlock(absBlock) {
    if (absBlock === 0) return;
    const relToFirst = absBlock - this.firstDataBlock;
    const g = Math.floor(relToFirst / this.blocksPerGroup);
    const b = relToFirst % this.blocksPerGroup;
    const descOff = this.bgdtOffset + g * 32;
    const bitmapBlock = this.view.getUint32(descOff + 0, true);
    const byteIdx = this.blockByteOffset(bitmapBlock) + (b >> 3);
    const mask = 1 << (b & 7);
    if ((this.u8[byteIdx] & mask) !== 0) {
      this.u8[byteIdx] &= ~mask;
      const freeCount = this.view.getUint16(descOff + 12, true);
      this.view.setUint16(descOff + 12, freeCount + 1, true);
      this.syncBackupBgdt(g);
      this.adjustSuperFreeBlocks(1);
    }
  }

  allocInode(isDir = false) {
    for (let g = 0; g < this.numGroups; g++) {
      const descOff = this.bgdtOffset + g * 32;
      const freeCount = this.view.getUint16(descOff + 14, true);
      if (freeCount === 0) continue;

      const bitmapBlock = this.view.getUint32(descOff + 4, true);
      const ibOff = this.blockByteOffset(bitmapBlock);

      for (let i = 0; i < this.inodesPerGroup; i++) {
        const byteIdx = ibOff + (i >> 3);
        const mask = 1 << (i & 7);
        if ((this.u8[byteIdx] & mask) === 0) {
          this.u8[byteIdx] |= mask;
          this.view.setUint16(descOff + 14, freeCount - 1, true);
          if (isDir) {
            const dirs = this.view.getUint16(descOff + 16, true);
            this.view.setUint16(descOff + 16, dirs + 1, true);
          }
          this.syncBackupBgdt(g);
          this.adjustSuperFreeInodes(-1);
          const ino = g * this.inodesPerGroup + i + 1;
          const inoOff = this.inodeByteOffset(ino);
          this.u8.fill(0, inoOff, inoOff + this.inodeSize);
          return ino;
        }
      }
    }
    throw new Error('No free inodes left on virtual ext2 disk');
  }

  freeInode(ino, isDir = false) {
    const idx = ino - 1;
    const g = Math.floor(idx / this.inodesPerGroup);
    const i = idx % this.inodesPerGroup;
    const descOff = this.bgdtOffset + g * 32;
    const bitmapBlock = this.view.getUint32(descOff + 4, true);
    const byteIdx = this.blockByteOffset(bitmapBlock) + (i >> 3);
    const mask = 1 << (i & 7);
    if ((this.u8[byteIdx] & mask) !== 0) {
      this.u8[byteIdx] &= ~mask;
      const freeCount = this.view.getUint16(descOff + 14, true);
      this.view.setUint16(descOff + 14, freeCount + 1, true);
      if (isDir) {
        const dirs = this.view.getUint16(descOff + 16, true);
        if (dirs > 0) this.view.setUint16(descOff + 16, dirs - 1, true);
      }
      this.syncBackupBgdt(g);
      this.adjustSuperFreeInodes(1);
    }
  }

  readInode(ino) {
    const off = this.inodeByteOffset(ino);
    const pointers = [];
    for (let i = 0; i < 15; i++) {
      pointers.push(this.view.getUint32(off + 40 + i * 4, true));
    }
    return {
      ino,
      mode: this.view.getUint16(off + 0, true),
      uid: this.view.getUint16(off + 2, true),
      size: this.view.getUint32(off + 4, true),
      atime: this.view.getUint32(off + 8, true),
      ctime: this.view.getUint32(off + 12, true),
      mtime: this.view.getUint32(off + 16, true),
      dtime: this.view.getUint32(off + 20, true),
      gid: this.view.getUint16(off + 24, true),
      linksCount: this.view.getUint16(off + 26, true),
      blocks512: this.view.getUint32(off + 28, true),
      pointers,
    };
  }

  writeInode(ino, fields) {
    const off = this.inodeByteOffset(ino);
    this.view.setUint16(off + 0, fields.mode, true);
    this.view.setUint16(off + 2, fields.uid ?? UID_TC, true);
    this.view.setUint32(off + 4, fields.size >>> 0, true);
    this.view.setUint32(off + 8, fields.atime ?? 0, true);
    this.view.setUint32(off + 12, fields.ctime ?? 0, true);
    this.view.setUint32(off + 16, fields.mtime ?? 0, true);
    this.view.setUint32(off + 20, fields.dtime ?? 0, true);
    this.view.setUint16(off + 24, fields.gid ?? GID_STAFF, true);
    this.view.setUint16(off + 26, fields.linksCount, true);
    this.view.setUint32(off + 28, fields.blocks512 >>> 0, true);
    if (fields.pointers) {
      for (let i = 0; i < 15; i++) {
        this.view.setUint32(off + 40 + i * 4, fields.pointers[i] || 0, true);
      }
    }
  }

  collectDataBlocks(inode) {
    const ptrsPerBlock = this.blockSize / 4;
    const totalDataBlocks = Math.ceil(inode.size / this.blockSize);
    const dataBlocks = [];
    const metaBlocks = [];

    const readPtr = (blockNum, idx) =>
      this.view.getUint32(this.blockByteOffset(blockNum) + idx * 4, true);

    for (let i = 0; i < 12 && dataBlocks.length < totalDataBlocks; i++) {
      dataBlocks.push(inode.pointers[i]);
    }

    if (dataBlocks.length < totalDataBlocks && inode.pointers[12]) {
      metaBlocks.push(inode.pointers[12]);
      for (let i = 0; i < ptrsPerBlock && dataBlocks.length < totalDataBlocks; i++) {
        dataBlocks.push(readPtr(inode.pointers[12], i));
      }
    }

    if (dataBlocks.length < totalDataBlocks && inode.pointers[13]) {
      metaBlocks.push(inode.pointers[13]);
      for (let i = 0; i < ptrsPerBlock && dataBlocks.length < totalDataBlocks; i++) {
        const l1 = readPtr(inode.pointers[13], i);
        if (!l1) break;
        metaBlocks.push(l1);
        for (let j = 0; j < ptrsPerBlock && dataBlocks.length < totalDataBlocks; j++) {
          dataBlocks.push(readPtr(l1, j));
        }
      }
    }

    return { dataBlocks, metaBlocks };
  }

  freeInodeBlocks(ino) {
    const inode = this.readInode(ino);
    const { dataBlocks, metaBlocks } = this.collectDataBlocks(inode);
    for (const b of dataBlocks) this.freeBlock(b);
    for (const b of metaBlocks) this.freeBlock(b);
    inode.size = 0;
    inode.blocks512 = 0;
    inode.pointers.fill(0);
    this.writeInode(ino, inode);
  }

  writeInodePayload(ino, bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.freeInodeBlocks(ino);

    const inode = this.readInode(ino);
    const ptrsPerBlock = this.blockSize / 4;
    const neededDataBlocks = Math.ceil(data.byteLength / this.blockSize);
    const maxSupportedBlocks = 12 + ptrsPerBlock + ptrsPerBlock * ptrsPerBlock;
    if (neededDataBlocks > maxSupportedBlocks) {
      throw new Error('File exceeds ext2 double-indirect size limit');
    }

    const pointers = new Array(15).fill(0);
    let totalAllocatedBlocks = 0;

    const writePtr = (blockNum, idx, value) => {
      this.view.setUint32(this.blockByteOffset(blockNum) + idx * 4, value, true);
    };

    let l1Block = 0;
    let l2Block = 0;
    let currentL2Child = 0;
    let currentL2ChildIndex = -1;

    for (let blkIdx = 0; blkIdx < neededDataBlocks; blkIdx++) {
      const dataBlock = this.allocBlock();
      totalAllocatedBlocks++;
      const start = blkIdx * this.blockSize;
      const end = Math.min(start + this.blockSize, data.byteLength);
      this.u8.set(data.subarray(start, end), this.blockByteOffset(dataBlock));

      if (blkIdx < 12) {
        pointers[blkIdx] = dataBlock;
      } else if (blkIdx < 12 + ptrsPerBlock) {
        if (!l1Block) {
          l1Block = this.allocBlock();
          totalAllocatedBlocks++;
          pointers[12] = l1Block;
        }
        writePtr(l1Block, blkIdx - 12, dataBlock);
      } else {
        if (!l2Block) {
          l2Block = this.allocBlock();
          totalAllocatedBlocks++;
          pointers[13] = l2Block;
        }
        const rem = blkIdx - 12 - ptrsPerBlock;
        const outerIdx = Math.floor(rem / ptrsPerBlock);
        const innerIdx = rem % ptrsPerBlock;
        if (outerIdx !== currentL2ChildIndex) {
          currentL2Child = this.allocBlock();
          totalAllocatedBlocks++;
          writePtr(l2Block, outerIdx, currentL2Child);
          currentL2ChildIndex = outerIdx;
        }
        writePtr(currentL2Child, innerIdx, dataBlock);
      }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    inode.size = data.byteLength;
    inode.blocks512 = totalAllocatedBlocks * (this.blockSize / SECTOR_SIZE);
    inode.mtime = nowSec;
    inode.ctime = nowSec;
    inode.pointers = pointers;
    this.writeInode(ino, inode);
  }

  readInodePayload(ino) {
    const inode = this.readInode(ino);
    const out = new Uint8Array(inode.size);
    const { dataBlocks } = this.collectDataBlocks(inode);
    let written = 0;

    for (const blk of dataBlocks) {
      const len = Math.min(this.blockSize, inode.size - written);
      const off = this.blockByteOffset(blk);
      out.set(this.u8.subarray(off, off + len), written);
      written += len;
    }
    return out;
  }

  initRootDirectory() {
    const nowSec = Math.floor(Date.now() / 1000);
    const rootBlk = this.allocBlock(0);
    this.writeInode(2, {
      mode: S_IFDIR | 0o777,
      uid: 0,
      gid: 0,
      size: this.blockSize,
      atime: nowSec,
      ctime: nowSec,
      mtime: nowSec,
      linksCount: 2,
      blocks512: this.blockSize / SECTOR_SIZE,
      pointers: [rootBlk, ...new Array(14).fill(0)],
    });
    const descOff = this.bgdtOffset;
    this.view.setUint16(descOff + 16, 1, true);
    this.syncBackupBgdt(0);
    this.writeDirectoryEntries(2, [
      { ino: 2, name: '.', fileType: FT_DIR },
      { ino: 2, name: '..', fileType: FT_DIR },
    ]);
  }

  readDirectoryEntries(dirIno) {
    const bytes = this.readInodePayload(dirIno);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries = [];
    let pos = 0;
    while (pos + 8 <= bytes.byteLength) {
      const ino = dv.getUint32(pos, true);
      const recLen = dv.getUint16(pos + 4, true);
      const nameLen = bytes[pos + 6];
      const fileType = bytes[pos + 7];
      if (recLen < 8) break;
      if (ino !== 0 && nameLen > 0) {
        const name = utf8Decoder.decode(bytes.subarray(pos + 8, pos + 8 + nameLen));
        entries.push({ ino, name, fileType });
      }
      pos += recLen;
    }
    return entries;
  }

  writeDirectoryEntries(dirIno, entries) {
    const blocks = [];
    let currentBlock = new Uint8Array(this.blockSize);
    let currentView = new DataView(currentBlock.buffer);
    let offset = 0;
    let lastEntryPos = -1;

    for (const entry of entries) {
      const nameBytes = utf8Encoder.encode(entry.name);
      const minLen = align4(8 + nameBytes.length);
      if (offset + minLen > this.blockSize) {
        if (lastEntryPos >= 0) {
          currentView.setUint16(lastEntryPos + 4, this.blockSize - lastEntryPos, true);
        }
        blocks.push(currentBlock);
        currentBlock = new Uint8Array(this.blockSize);
        currentView = new DataView(currentBlock.buffer);
        offset = 0;
        lastEntryPos = -1;
      }
      currentView.setUint32(offset + 0, entry.ino, true);
      currentView.setUint16(offset + 4, minLen, true);
      currentBlock[offset + 6] = nameBytes.length;
      currentBlock[offset + 7] = entry.fileType;
      currentBlock.set(nameBytes, offset + 8);
      lastEntryPos = offset;
      offset += minLen;
    }

    if (lastEntryPos >= 0) {
      currentView.setUint16(lastEntryPos + 4, this.blockSize - lastEntryPos, true);
    }
    blocks.push(currentBlock);

    const payload = new Uint8Array(blocks.length * this.blockSize);
    blocks.forEach((blk, idx) => payload.set(blk, idx * this.blockSize));
    this.writeInodePayload(dirIno, payload);
  }

  resolvePath(pathStr) {
    const parts = pathStr.split('/').filter(Boolean);
    let currentIno = 2;
    for (const part of parts) {
      const entries = this.readDirectoryEntries(currentIno);
      const match = entries.find((e) => e.name === part);
      if (!match) return null;
      currentIno = match.ino;
    }
    return currentIno;
  }

  ensureDirectory(pathStr, mode = 0o777) {
    const parts = pathStr.split('/').filter(Boolean);
    let currentIno = 2;

    for (const part of parts) {
      const entries = this.readDirectoryEntries(currentIno);
      const match = entries.find((e) => e.name === part);
      if (match) {
        currentIno = match.ino;
        continue;
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const newIno = this.allocInode(true);
      this.writeInode(newIno, {
        mode: S_IFDIR | mode,
        uid: UID_TC,
        gid: GID_STAFF,
        size: this.blockSize,
        atime: nowSec,
        ctime: nowSec,
        mtime: nowSec,
        linksCount: 2,
        blocks512: 0,
        pointers: new Array(15).fill(0),
      });
      this.writeDirectoryEntries(newIno, [
        { ino: newIno, name: '.', fileType: FT_DIR },
        { ino: currentIno, name: '..', fileType: FT_DIR },
      ]);

      entries.push({ ino: newIno, name: part, fileType: FT_DIR });
      this.writeDirectoryEntries(currentIno, entries);

      const parent = this.readInode(currentIno);
      parent.linksCount += 1;
      this.writeInode(currentIno, parent);

      currentIno = newIno;
    }
    return currentIno;
  }

  writeFile(fullPath, data, mode = 0o644) {
    const parts = fullPath.split('/').filter(Boolean);
    if (parts.length === 0) throw new Error('Invalid file path');
    const fileName = parts.pop();
    const parentIno = this.ensureDirectory('/' + parts.join('/'));
    const entries = this.readDirectoryEntries(parentIno);
    const existing = entries.find((e) => e.name === fileName);
    const nowSec = Math.floor(Date.now() / 1000);

    if (existing) {
      const existingInode = this.readInode(existing.ino);
      if ((existingInode.mode & S_IFDIR) === S_IFDIR) {
        throw new Error(`Cannot overwrite directory ${fullPath}`);
      }
      this.writeInodePayload(existing.ino, data);
      const updated = this.readInode(existing.ino);
      updated.mode = S_IFREG | mode;
      updated.mtime = nowSec;
      this.writeInode(existing.ino, updated);
      return existing.ino;
    }

    const fileIno = this.allocInode(false);
    this.writeInode(fileIno, {
      mode: S_IFREG | mode,
      uid: UID_TC,
      gid: GID_STAFF,
      size: 0,
      atime: nowSec,
      ctime: nowSec,
      mtime: nowSec,
      linksCount: 1,
      blocks512: 0,
      pointers: new Array(15).fill(0),
    });
    this.writeInodePayload(fileIno, data);
    entries.push({ ino: fileIno, name: fileName, fileType: FT_REG_FILE });
    this.writeDirectoryEntries(parentIno, entries);
    return fileIno;
  }

  readFile(fullPath) {
    const ino = this.resolvePath(fullPath);
    if (!ino) throw new Error(`File not found: ${fullPath}`);
    return this.readInodePayload(ino);
  }

  listDirectory(dirPath) {
    const dirIno = this.resolvePath(dirPath);
    if (!dirIno) return [];
    return this.readDirectoryEntries(dirIno)
      .filter((e) => e.name !== '.' && e.name !== '..')
      .map((e) => {
        const inode = this.readInode(e.ino);
        return {
          name: e.name,
          ino: e.ino,
          isDir: (inode.mode & S_IFDIR) === S_IFDIR,
          size: inode.size,
          mtime: inode.mtime,
        };
      });
  }

  deleteFile(fullPath) {
    const parts = fullPath.split('/').filter(Boolean);
    if (parts.length === 0) return false;
    const fileName = parts.pop();
    const parentIno = this.resolvePath('/' + parts.join('/'));
    if (!parentIno) return false;

    const entries = this.readDirectoryEntries(parentIno);
    const idx = entries.findIndex((e) => e.name === fileName);
    if (idx === -1) return false;

    const target = entries[idx];
    const inode = this.readInode(target.ino);
    if ((inode.mode & S_IFDIR) === S_IFDIR) {
      throw new Error('Directory deletion is not supported here');
    }

    entries.splice(idx, 1);
    this.writeDirectoryEntries(parentIno, entries);

    inode.linksCount -= 1;
    if (inode.linksCount <= 0) {
      this.freeInodeBlocks(target.ino);
      this.freeInode(target.ino, false);
    } else {
      this.writeInode(target.ino, inode);
    }
    return true;
  }

  getStats() {
    const freeBlocks = this.getFreeBlocksCount();
    const totalBytes = this.blocksCount * this.blockSize;
    const freeBytes = freeBlocks * this.blockSize;
    return {
      totalBytes,
      freeBytes,
      usedBytes: totalBytes - freeBytes,
      freeInodes: this.getFreeInodesCount(),
    };
  }
}
