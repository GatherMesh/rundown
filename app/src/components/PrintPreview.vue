<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { renderDocument, type RenderPayload } from '../render/renderer';
const props = defineProps<{ payload: RenderPayload | null }>();
const emit = defineEmits<{ rendered: [{ pageCount: number; warning: string | null }] }>();
const html = ref(''),
  warning = ref(''),
  busy = ref(false),
  container = ref<HTMLElement>(),
  scale = ref(0.3),
  count = ref(0);
let version = 0,
  observer: ResizeObserver | undefined;
function resize() {
  scale.value = Math.min(
    1,
    ((container.value?.clientWidth ?? 400) - 4) /
      (props.payload?.template.orientation === 'landscape' ? 1123 : 794),
  );
}
watch(
  () => props.payload,
  async (p) => {
    const current = ++version;
    if (!p) {
      html.value = '';
      return;
    }
    busy.value = true;
    try {
      const result = await renderDocument(p);
      if (current !== version) return;
      html.value = result.html;
      count.value = result.pageCount;
      warning.value = result.warning ?? '';
      resize();
      emit('rendered', result);
    } catch (e) {
      if (current === version) warning.value = String(e);
    } finally {
      if (current === version) busy.value = false;
    }
  },
  { immediate: true, deep: true },
);
onMounted(() => {
  observer = new ResizeObserver(resize);
  if (container.value) observer.observe(container.value);
  resize();
});
onUnmounted(() => {
  observer?.disconnect();
  version++;
});
</script>
<template>
  <div ref="container" class="print-preview">
    <q-linear-progress v-if="busy" indeterminate color="primary" /><q-banner
      v-if="warning"
      class="bg-orange-1"
      >{{ warning }}</q-banner
    >
    <div
      v-if="payload"
      class="preview-pages"
      :style="{
        height: count * (payload.template.orientation === 'landscape' ? 794 : 1123) * scale + 'px',
      }"
    >
      <div class="preview-scale" :style="{ transform: `scale(${scale})` }" v-html="html" />
    </div>
    <div v-else class="empty-state">Select a session to preview this template.</div>
    <p v-if="count" class="preview-caption">
      {{ count }} {{ count === 1 ? 'page' : 'pages' }} · A4 {{ payload?.template.orientation }}
    </p>
  </div>
</template>
