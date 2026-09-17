<script setup lang="ts">
import { APP_NAME, type AdminUser } from "@icooro/shared";

definePageMeta({ layout: "admin" });
defineOptions({ name: "AdminUsersPage" });

const api = useApi();
const users = ref<AdminUser[]>([]);
const loading = ref(true);
const error = ref("");
const updatingId = ref<string | null>(null);

async function loadUsers() {
  loading.value = true;
  error.value = "";
  try {
    users.value = await api.get<AdminUser[]>("/admin/users");
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : "Failed to load users.";
  } finally {
    loading.value = false;
  }
}

async function toggleRole(user: AdminUser) {
  const nextRole = user.role === "admin" ? "user" : "admin";
  updatingId.value = user.id;
  try {
    const updated = await api.patch<AdminUser>(`/admin/users/${user.id}`, { role: nextRole });
    const idx = users.value.findIndex((u) => u.id === user.id);
    if (idx !== -1) {
      users.value[idx] = updated;
    }
  } catch (err: unknown) {
    alert(err instanceof Error ? err.message : "Failed to update user role.");
  } finally {
    updatingId.value = null;
  }
}

onMounted(loadUsers);
</script>

<template>
  <section class="admin-page">
    <p class="eyebrow">{{ APP_NAME }} Admin</p>
    <div class="title-row">
      <div>
        <h1>Users</h1>
        <p class="lede">Manage system user accounts and administrative roles.</p>
      </div>
      <button class="btn-secondary" :disabled="loading" @click="loadUsers">Refresh</button>
    </div>

    <div v-if="loading" class="status-msg" role="status">Loading users…</div>
    <div v-else-if="error" class="status-msg error" role="alert">{{ error }}</div>
    <div v-else-if="users.length === 0" class="empty-state">No users registered in the system.</div>

    <div v-else class="table-container">
      <table class="data-table">
        <thead>
          <tr>
            <th>User</th>
            <th>Email</th>
            <th>Role</th>
            <th>Created</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td class="primary-cell">
              <strong>{{ u.name }}</strong>
              <span class="subtext">{{ u.id }}</span>
            </td>
            <td>{{ u.email }}</td>
            <td>
              <span class="role-badge" :class="u.role">{{ u.role }}</span>
            </td>
            <td>{{ new Date(u.createdAt).toLocaleString() }}</td>
            <td>
              <button
                class="btn-action"
                :disabled="updatingId === u.id"
                @click="toggleRole(u)"
              >
                {{ updatingId === u.id ? 'Updating…' : (u.role === 'admin' ? 'Demote to User' : 'Make Admin') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.admin-page {
  max-width: 1200px;
}
.eyebrow {
  color: #d35b3e;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin: 0 0 0.5rem;
}
.title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.5rem;
}
h1 {
  margin: 0 0 0.5rem;
  font-size: 1.6rem;
  color: #ffffff;
}
.lede {
  color: #cfd6db;
  max-width: 65ch;
  margin: 0;
}
.btn-secondary {
  background: #1a2128;
  border: 1px solid #2a323b;
  color: #e6e9ec;
  padding: 0.45rem 0.9rem;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 600;
}
.btn-secondary:hover:not(:disabled) {
  background: #222b34;
  border-color: #d35b3e;
}
.status-msg {
  padding: 1rem;
  background: #1a2128;
  border-radius: 6px;
  color: #cfd6db;
  margin-bottom: 1.5rem;
}
.status-msg.error {
  border-left: 4px solid #d35b3e;
  color: #ff8a70;
}
.empty-state {
  padding: 2.5rem;
  text-align: center;
  background: #1a2128;
  border: 1px dashed #2a323b;
  border-radius: 6px;
  color: #8b949e;
}
.table-container {
  overflow-x: auto;
  border: 1px solid #2a323b;
  border-radius: 6px;
  background: #141a20;
}
.data-table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
  font-size: 0.9rem;
}
.data-table th {
  background: #1a2128;
  color: #8b949e;
  font-weight: 600;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid #2a323b;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-size: 0.75rem;
}
.data-table td {
  padding: 0.85rem 1rem;
  border-bottom: 1px solid #1f272f;
  color: #cfd6db;
  vertical-align: middle;
}
.data-table tbody tr:hover {
  background: #1a2128;
}
.primary-cell {
  display: flex;
  flex-direction: column;
}
.primary-cell strong {
  color: #ffffff;
}
.subtext {
  font-size: 0.75rem;
  color: #6b7682;
  font-family: monospace;
}
.role-badge {
  display: inline-block;
  padding: 0.2rem 0.55rem;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.role-badge.admin {
  background: #4a221b;
  color: #ff8a70;
  border: 1px solid #d35b3e;
}
.role-badge.user {
  background: #1f272f;
  color: #8b949e;
  border: 1px solid #2a323b;
}
.btn-action {
  background: #1f272f;
  border: 1px solid #2a323b;
  color: #e6e9ec;
  padding: 0.35rem 0.65rem;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.8rem;
  font-weight: 600;
}
.btn-action:hover:not(:disabled) {
  border-color: #d35b3e;
  background: #2a3440;
}
.btn-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
