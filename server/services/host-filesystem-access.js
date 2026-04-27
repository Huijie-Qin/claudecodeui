export function canAccessHostFilesystem(user) {
  return user?.is_system_admin === 1 || user?.is_system_admin === true;
}
