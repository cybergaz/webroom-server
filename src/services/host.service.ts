import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { users } from '../db/schema';
import * as adminService from './admin.service';

const err = (status: number, message: string) => Object.assign(new Error(message), { status });

/**
 * Resolve the admin id that "owns" a host — the admin who created the host.
 * Hosts managing users act on behalf of that admin, so all user operations
 * reuse the admin-scoped service functions with this id.
 */
async function getHostAdminId(hostId: string): Promise<string> {
  const host = await db.query.users.findFirst({
    where: eq(users.id, hostId),
    columns: { role: true, createdByUserId: true },
  });
  if (!host || host.role !== 'host') throw err(403, 'Not a host account');
  if (!host.createdByUserId) throw err(409, 'Host is not owned by an admin');

  const creator = await db.query.users.findFirst({
    where: eq(users.id, host.createdByUserId),
    columns: { role: true },
  });
  if (creator?.role !== 'admin') throw err(409, 'Host owner is not an admin');

  return host.createdByUserId;
}

export async function listUsers(hostId: string) {
  const adminId = await getHostAdminId(hostId);
  return adminService.listUsers(adminId);
}

export async function updateUser(
  hostId: string,
  userId: string,
  data: { name?: string; password?: string; },
) {
  const adminId = await getHostAdminId(hostId);
  return adminService.updateUserByHost(userId, adminId, data);
}

export async function activateUser(hostId: string, userId: string) {
  const adminId = await getHostAdminId(hostId);
  return adminService.activateUser(userId, adminId);
}

export async function deactivateUser(hostId: string, userId: string) {
  const adminId = await getHostAdminId(hostId);
  return adminService.deactivateUser(userId, adminId);
}

export async function forceLogoutUser(hostId: string, userId: string) {
  const adminId = await getHostAdminId(hostId);
  return adminService.forceLogoutUser(userId, adminId);
}

export async function allowDeviceChange(hostId: string, userId: string) {
  const adminId = await getHostAdminId(hostId);
  return adminService.allowDeviceChange(userId, adminId);
}

export async function resetDeviceLock(hostId: string, userId: string) {
  const adminId = await getHostAdminId(hostId);
  return adminService.resetDeviceLock(userId, adminId);
}

export async function deleteUser(hostId: string, userId: string) {
  const adminId = await getHostAdminId(hostId);
  return adminService.deonboardUser(userId, adminId);
}
