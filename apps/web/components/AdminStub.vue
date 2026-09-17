<script setup lang="ts">
import { APP_NAME } from "@icooro/shared";

defineProps<{ section: string }>();
</script>

<template>
  <section>
    <p class="eyebrow">{{ APP_NAME }} Admin</p>
    <h1>{{ section }}</h1>
    <p class="lede">
      This admin section is a foundation stub. The C6.1 release establishes
      the route, layout, and the authentication/authorization boundary for
      <code>/admin</code>. Full management UI and CRUD actions will be
      delivered in a later phase.
    </p>
  </section>
</template>

<style scoped>
.eyebrow {
  color: #d35b3e;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin: 0 0 0.5rem;
}
h1 {
  margin: 0 0 0.5rem;
  font-size: 1.6rem;
}
.lede {
  color: #cfd6db;
  max-width: 60ch;
  margin: 0;
}
code {
  background: #1a2128;
  padding: 0 0.35rem;
  border-radius: 3px;
}
</style>
