<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import SessionsPage from './SessionsPage.vue';
import TemplatesPage from './TemplatesPage.vue';
import ExportPage from './ExportPage.vue';
import ReferencePage from './ReferencePage.vue';
import OrganisationPage from './OrganisationPage.vue';
import EmailPage from './EmailPage.vue';
const route = useRoute();
const page = computed(() => String(route.params.page || 'sessions'));
</script>
<template>
  <SessionsPage v-if="page === 'sessions'" /><TemplatesPage
    v-else-if="page === 'templates'"
  /><ExportPage v-else-if="page === 'export'" /><ReferencePage
    v-else-if="['people', 'categories'].includes(page)"
    :kind="page"
  />
  <OrganisationPage v-else-if="page === 'organisation'" />
  <EmailPage v-else-if="page === 'email'" />
  <main v-else class="empty-state">
    <h1>Page not found</h1>
    <router-link to="/sessions">Open sessions</router-link>
  </main>
</template>
