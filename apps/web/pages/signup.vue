<script setup lang="ts">
import type { ApiError } from "@icooro/shared";

definePageMeta({ layout: "default" });

const auth = useAuth();
const submitting = ref(false);
const errorMessage = ref("");
const form = reactive({ name: "", email: "", password: "" });

async function onSubmit() {
  submitting.value = true;
  errorMessage.value = "";
  try {
    // Plain object (not the reactive form) so the JSON body is exactly
    // SignupInput: { name, email, password }.
    await auth.signup({
      name: form.name,
      email: form.email,
      password: form.password,
    });
    await navigateTo("/app");
  } catch (err: unknown) {
    const apiErr = err as ApiError | null;
    errorMessage.value =
      apiErr?.message ?? (err instanceof Error ? err.message : "Signup failed");
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <main class="page">
    <section class="card">
      <h1>Create your account</h1>
      <p class="muted">Set up your Icooro workspace in a few seconds.</p>
      <form @submit.prevent="onSubmit" class="form">
        <label>
          Name
          <input v-model="form.name" required minlength="1" maxlength="120" placeholder="Your name" />
        </label>
        <label>
          Email
          <input v-model="form.email" type="email" required autocomplete="email" placeholder="you@example.com" />
        </label>
        <label>
          Password
          <input
            v-model="form.password"
            type="password"
            required
            minlength="8"
            maxlength="200"
            autocomplete="new-password"
            placeholder="At least 8 characters"
          />
        </label>
        <p v-if="errorMessage" role="alert" class="error">{{ errorMessage }}</p>
        <button type="submit" :disabled="submitting">
          {{ submitting ? "Creating…" : "Create account" }}
        </button>
        <p class="hint">
          Already have an account?
          <NuxtLink to="/login">Sign in</NuxtLink>
        </p>
      </form>
    </section>
  </main>
</template>

<style scoped>
.page {
  flex: 1;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 3rem 1.25rem;
  font-family: system-ui, sans-serif;
}
.card {
  width: 100%;
  max-width: 460px;
  background: #fff;
  border: 1px solid #dbe2ea;
  border-radius: 8px;
  padding: 2rem;
  box-shadow: 0 10px 30px rgba(23, 107, 101, 0.06);
}
h1 {
  margin: 0 0 0.5rem;
  font-size: 1.5rem;
}
.muted {
  color: #52606d;
  margin: 0 0 1.5rem;
}
.form {
  display: grid;
  gap: 1rem;
}
label {
  display: grid;
  gap: 0.4rem;
  font-weight: 600;
}
input {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid #b7c2cc;
  border-radius: 4px;
  padding: 0.6rem;
  font: inherit;
}
button {
  border: 0;
  border-radius: 4px;
  background: #304fd8;
  color: #fff;
  padding: 0.7rem 1rem;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}
button:disabled {
  opacity: 0.65;
  cursor: wait;
}
.error {
  color: #b42318;
  margin: 0;
}
.hint {
  margin: 0;
  color: #52606d;
  text-align: center;
}
</style>
