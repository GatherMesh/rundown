<script setup lang="ts">
import { ref } from 'vue';
import { Notify } from 'quasar';
import { useWorkspace } from '../stores/workspace';

const w = useWorkspace();
const file = ref<File | null>(null);
const uploading = ref(false);

async function upload(selected: File | null) {
  if (!selected || uploading.value) return;
  const name = w.tenant?.name;
  uploading.value = true;
  try {
    await w.uploadOrganisationLogo(selected);
    Notify.create({ type: 'positive', message: `Logo saved for ${name}.` });
  } catch (e) {
    w.fail(e);
  } finally {
    uploading.value = false;
    file.value = null;
  }
}
</script>

<template>
  <main class="workspace-main organisation-page">
    <div class="section-heading">
      <div>
        <h1>Organisation</h1>
        <p class="muted">{{ w.tenant?.name }}</p>
      </div>
    </div>
    <section class="card form-stack" aria-labelledby="logo-heading" :aria-busy="uploading">
      <div>
        <h2 id="logo-heading">Organisation logo</h2>
        <p class="muted">
          Used in session packs when the template’s Logo option is on. An event’s own logo takes
          priority.
        </p>
      </div>
      <div class="organisation-logo-preview">
        <img v-if="w.tenant?.logo?.url" :src="w.tenant.logo.url" :alt="w.tenant.name + ' logo'" />
        <span v-else class="muted">No logo uploaded</span>
      </div>
      <p v-if="w.tenant?.logo" class="muted organisation-logo-name">{{ w.tenant.logo.name }}</p>
      <q-file
        v-if="w.role === 'owner'"
        v-model="file"
        outlined
        dense
        accept="image/png,image/jpeg"
        :label="w.tenant?.logo ? 'Replace logo' : 'Upload logo'"
        hint="PNG or JPG · up to 10 MB · saves automatically"
        :disable="uploading"
        @update:model-value="upload"
      >
        <template #prepend><q-icon name="file_upload" /></template>
      </q-file>
      <p v-else class="muted">Only organisation owners can change the logo.</p>
      <div v-if="uploading" role="status">
        <q-linear-progress indeterminate color="primary" />
        <p class="muted">Uploading and saving logo…</p>
      </div>
    </section>
  </main>
</template>
