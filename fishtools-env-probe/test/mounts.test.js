import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMounts, isNetworkFsType, parseLinuxMounts, parseMacMounts } from '../lib/mounts.js';

test('isNetworkFsType 识别网络与集群文件系统', () => {
  for (const fstype of [
    'nfs',
    'nfs4',
    'cifs',
    'smb3',
    'sshfs',
    'fuse.sshfs',
    'fuse.rclone',
    'fuse.smbnetfs',
    'davfs',
    'davfs2',
    'webdav',
    'autofs',
    '9p',
    'ceph',
    'afs',
    'glusterfs',
    'lustre',
    'vboxsf',
    'NFS4',
  ]) {
    assert.equal(isNetworkFsType(fstype), true, `${fstype} 应被判为远程文件系统`);
  }
});

test('isNetworkFsType 不误判本地文件系统', () => {
  for (const fstype of ['ext4', 'xfs', 'btrfs', 'zfs', 'apfs', 'hfs', 'ntfs', 'fat32', 'tmpfs', 'devtmpfs', 'overlay', 'squashfs', 'fuse.ntfs', 'fuse.mergerfs', '']) {
    assert.equal(isNetworkFsType(fstype), false, `${fstype} 不应被判为远程文件系统`);
  }
  assert.equal(isNetworkFsType(undefined), false);
  assert.equal(isNetworkFsType(null), false);
});

test('parseLinuxMounts 解析挂载表并还原转义字符', () => {
  const text = [
    '/dev/sda1 / ext4 rw,relatime 0 0',
    'server:/export /home nfs4 rw,addr=10.0.0.1 0 0',
    '//cifs-host/share /mnt/data cifs rw,username=u 0 0',
    '/dev/sdb1 /mnt/My\\040Disk xfs rw 0 0',
    '# 这是注释',
    '',
  ].join('\n');
  const entries = parseLinuxMounts(text);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries[1], { source: 'server:/export', mount: '/home', fstype: 'nfs4' });
  assert.equal(entries[2].fstype, 'cifs');
  assert.equal(entries[3].mount, '/mnt/My Disk', '空格转义要还原');
});

test('parseMacMounts 解析 mount 命令输出', () => {
  const text = [
    '/dev/disk1s1 on / (apfs, local, journaled)',
    'map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)',
    'nfs-server:/export on /mnt/nfs (nfs, nodev, nosuid)',
  ].join('\n');
  const entries = parseMacMounts(text);
  assert.equal(entries.length, 3);
  assert.equal(entries[1].fstype, 'autofs');
  assert.equal(entries[2].mount, '/mnt/nfs');
  assert.equal(entries[0].fstype, 'apfs');
});

test('formatMounts 生成可读摘要', () => {
  assert.equal(formatMounts([{ mount: '/home', fstype: 'nfs4' }]), 'nfs4: /home');
  assert.equal(formatMounts([{ mount: '/a', fstype: 'nfs4' }, { mount: '/b', fstype: 'cifs' }]), 'nfs4: /a、cifs: /b');
  assert.equal(formatMounts([]), '');
});
