<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { Dialog } from 'quasar';
import { useWorkspace } from '../stores/workspace';
import type { ComputedItem, AvNotes } from '../types';
import { formatDuration, parseDuration, time } from '../render/domain';
const props = defineProps<{ item: ComputedItem }>();
defineEmits(['close', 'duplicate']);
const w = useWorkspace(),
  tab = ref<keyof AvNotes>('audio'),
  fullScript = ref(false),
  uploading = ref(false),
  durationError = ref('');
const durationInput = ref(formatDuration(props.item.durationSec));
watch(
  () => props.item.durationSec,
  (value) => (durationInput.value = formatDuration(value)),
);
const avTabs = ['audio', 'video', 'lighting', 'camera', 'slides'] as const;
const peopleSearch = ref('');
const peopleOptions = computed(() =>
  w.people.filter((p) =>
    (p.name + ' ' + p.role).toLowerCase().includes(peopleSearch.value.toLowerCase()),
  ),
);
const slideUrl = computed(() => props.item.imageSlide?.url);
function duration(v: string | null) {
  try {
    w.patchItem(props.item.id, { durationSec: parseDuration(String(v)) });
    durationError.value = '';
  } catch (e) {
    durationError.value = (e as Error).message;
  }
}
function newPerson() {
  Dialog.create({
    title: 'New person',
    prompt: { model: '', label: 'Full name', isValid: (v) => !!v.trim() },
    cancel: true,
  }).onOk(async (name: string) => {
    try {
      const id = await w.addPerson(name);
      w.patchItem(props.item.id, { personIds: [...props.item.personIds, id] });
    } catch (e) {
      w.fail(e);
    }
  });
}
async function upload(file?: File) {
  if (!file) return;
  uploading.value = true;
  try {
    const itemId = props.item.id,
      path = w.itemPath();
    const image = await w.uploadImage(file, `${path}/${itemId}`);
    await w.saveSlide(path, itemId, image);
  } catch (e) {
    w.fail(e);
  } finally {
    uploading.value = false;
  }
}
</script>
<template>
  <aside class="detail-panel">
    <div class="detail-heading">
      <span
        >Item {{ item.number }} of {{ w.items.length }} · starts
        <b class="mono">{{
          time(w.session!.startAt.toDate().toISOString(), item.startSec, w.event?.timeZone, true)
        }}</b></span
      ><q-btn
        flat
        round
        dense
        icon="close"
        aria-label="Close item details"
        @click="$emit('close')"
      />
    </div>
    <fieldset :disabled="!w.canEdit" class="form-stack">
      <label
        >Title<q-input
          class="item-title"
          :model-value="item.title"
          outlined
          dense
          @update:model-value="(v) => v && w.patchItem(item.id, { title: String(v) })"
      /></label>
      <div class="two-fields">
        <label
          >Duration<q-input
            v-model="durationInput"
            outlined
            dense
            input-class="mono"
            :error="!!durationError"
            :error-message="durationError"
            @blur="duration(durationInput)"
            @keyup.enter="duration(durationInput)" /></label
        ><label
          >Category<q-select
            :model-value="item.categoryId"
            :options="w.categories.filter((c) => !c.archived || c.id === item.categoryId)"
            option-label="name"
            option-value="id"
            emit-value
            map-options
            outlined
            dense
            @update:model-value="(v) => w.patchItem(item.id, { categoryId: v })"
        /></label>
      </div>
      <label
        >People<q-select
          :model-value="item.personIds"
          :options="peopleOptions"
          use-input
          input-debounce="0"
          @filter="
            (value: string, update: (callback: () => void) => void) =>
              update(() => {
                peopleSearch = value;
              })
          "
          :option-label="(p) => p.name + (p.role ? ' · ' + p.role : '')"
          option-value="id"
          multiple
          use-chips
          emit-value
          map-options
          outlined
          dense
          @update:model-value="(v) => w.patchItem(item.id, { personIds: v })" /></label
      ><q-btn
        flat
        dense
        no-caps
        color="primary"
        icon="person_add"
        label="Create new person"
        class="self-start"
        @click="newPerson"
      /><label
        >Notes<q-input
          :model-value="item.notes || ''"
          type="textarea"
          autogrow
          outlined
          dense
          @update:model-value="(v) => w.patchItem(item.id, { notes: String(v ?? '') })" /></label
      ><label
        ><span class="field-heading"
          >Script<q-btn
            flat
            dense
            no-caps
            size="sm"
            color="primary"
            label="Open full editor"
            @click="fullScript = true" /></span
        ><q-input
          :model-value="item.script || ''"
          type="textarea"
          rows="4"
          outlined
          dense
          aria-label="Script"
          @update:model-value="(v) => w.patchItem(item.id, { script: String(v ?? '') })"
      /></label>
      <section>
        <label>AV notes</label>
        <div class="segmented av-tabs" role="tablist">
          <button
            v-for="name in avTabs"
            :key="name"
            :class="{ active: tab === name }"
            :aria-selected="tab === name"
            role="tab"
            @click="tab = name"
          >
            {{ name }}<span v-if="item.av[name]"> •</span>
          </button>
        </div>
        <q-input
          :model-value="item.av[tab] || ''"
          type="textarea"
          rows="3"
          outlined
          dense
          :aria-label="tab + ' notes'"
          @update:model-value="
            (v) => w.patchItem(item.id, { av: { ...item.av, [tab]: String(v ?? '') } })
          "
        />
      </section>
      <section @dragover.prevent @drop.prevent="upload($event.dataTransfer?.files[0])">
        <label>Image slide</label>
        <div v-if="item.imageSlide" class="slide-upload">
          <img v-if="slideUrl" :src="slideUrl" :alt="item.imageSlide.name" />
          <div v-else class="image-placeholder">16:9 slide</div>
          <div>
            <small>{{ item.imageSlide.name }}</small>
            <div class="button-row">
              <label class="file-button"
                >Replace<input
                  type="file"
                  accept="image/png,image/jpeg"
                  @change="upload(($event.target as HTMLInputElement).files?.[0])" /></label
              ><q-btn
                outline
                dense
                no-caps
                color="negative"
                label="Remove"
                @click="w.patchItem(item.id, { imageSlide: null })"
              />
            </div>
          </div>
        </div>
        <label v-else class="upload-zone"
          ><q-icon name="add_photo_alternate" size="26px" /> Drop an image here, or browse<input
            type="file"
            accept="image/png,image/jpeg"
            @change="upload(($event.target as HTMLInputElement).files?.[0])"
          /><small>PNG or JPG · up to 10 MB</small></label
        ><q-linear-progress v-if="uploading" indeterminate color="primary" />
      </section>
      <div class="detail-bottom">
        <q-btn
          flat
          no-caps
          icon="content_copy"
          label="Duplicate item"
          @click="$emit('duplicate')"
        /><q-btn
          flat
          no-caps
          color="negative"
          icon="delete_outline"
          label="Delete"
          @click="w.removeItem(item.id).catch(w.fail)"
        />
      </div>
    </fieldset>
  </aside>
  <q-dialog v-model="fullScript"
    ><q-card class="script-dialog"
      ><q-card-section class="section-heading"
        ><h2>{{ item.title }} — script</h2>
        <q-btn flat round icon="close" v-close-popup /></q-card-section
      ><q-card-section
        ><q-input
          :model-value="item.script || ''"
          type="textarea"
          outlined
          rows="20"
          :readonly="!w.canEdit"
          @update:model-value="
            (v) => w.patchItem(item.id, { script: String(v ?? '') })
          " /></q-card-section
      ><q-card-actions align="right"
        ><q-btn color="primary" no-caps label="Done" v-close-popup /></q-card-actions></q-card
  ></q-dialog>
</template>
