<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { Dialog, Notify } from 'quasar';
import { useWorkspace } from '../stores/workspace';
import { labels } from '../render/renderer';
import { payload } from '../render/payload';
import PrintPreview from '../components/PrintPreview.vue';
import type { Template, HeaderField, ItemStyle } from '../types';
const w = useWorkspace(),
  selected = ref('producer-rundown'),
  personId = ref('priya'),
  dragIndex = ref(-1),
  deleting = ref(false),
  showArchived = ref(false);
const visibleTemplates = computed(() =>
  w.templates.filter((t) => showArchived.value || !t.archived),
);
const template = computed(
  () => visibleTemplates.value.find((t) => t.id === selected.value) ?? visibleTemplates.value[0],
);
const preview = computed(() =>
  template.value && w.session
    ? payload(w, template.value, w.people.find((p) => p.id === personId.value) ?? null)
    : null,
);
const styles: { value: ItemStyle; label: string; icon: string }[] = [
  { value: 'table', label: 'Table rows', icon: 'table_rows' },
  { value: 'cards', label: 'Cards', icon: 'view_agenda' },
  { value: 'denseCards', label: 'Dense Cards', icon: 'view_day' },
  { value: 'cueCard', label: 'Cue card', icon: 'article' },
  { value: 'compact', label: 'Compact list', icon: 'format_list_bulleted' },
];
const headers: Record<HeaderField, string> = {
  sessionName: 'Session name',
  eventName: 'Event name',
  sessionDateTime: 'Session date & time',
  logo: 'Logo',
  sessionSubtitle: 'Session subtitle',
  personName: 'Person name',
};
const usage = computed(
  () =>
    w.people.filter((p) => p.pack.templates.some((r) => r.templateId === template.value?.id))
      .length,
);
function patch(part: Partial<Template>) {
  if (template.value) w.patchTemplate(template.value.id, part);
}
function header(key: HeaderField, field: 'show' | 'align', value: boolean | string) {
  if (template.value)
    patch({
      header: {
        ...template.value.header,
        [key]: { ...template.value.header[key], [field]: value },
      },
    });
}
function column(index: number, field: 'visible' | 'width', value: boolean | string) {
  if (!template.value) return;
  if (field === 'width' && !/^(auto|\d+(\.\d+)?(px|fr))$/.test(String(value))) {
    w.fail(new Error('Column width must be auto, pixels (80px), or flex (1fr).'));
    return;
  }
  const cols = structuredClone(template.value.columns.map((c) => ({ ...c })));
  Object.assign(cols[index], { [field]: value });
  patch({ columns: cols });
}
function reorder(index: number) {
  if (!template.value || dragIndex.value === index) return;
  const cols = [...template.value.columns],
    moved = cols.splice(dragIndex.value, 1)[0];
  cols.splice(index, 0, moved);
  patch({ columns: cols });
}
function toggleCategory(id: string) {
  if (!template.value) return;
  const current = template.value.filter.categoryIds ?? w.categories.map((c) => c.id);
  const next = current.includes(id) ? current.filter((c) => c !== id) : [...current, id];
  patch({
    filter: {
      ...template.value.filter,
      categoryIds: next.length === w.categories.length ? null : next,
    },
  });
}
async function add(copy = false) {
  try {
    selected.value = await w.addTemplate(copy ? template.value : undefined);
  } catch (e) {
    w.fail(e);
  }
}
async function save() {
  try {
    await w.flush();
    Notify.create({ type: 'positive', message: 'Template saved' });
  } catch (e) {
    w.fail(e);
  }
}
function removeTemplate() {
  const target = template.value;
  const tenantId = w.tenantId;
  if (!target || !w.canEdit || deleting.value) return;
  Dialog.create({
    title: 'Delete template?',
    message: `Delete “${target.name}”? This cannot be undone. Templates used by packs cannot be deleted.`,
    cancel: true,
    persistent: true,
    ok: { label: 'Delete template', color: 'negative' },
  }).onOk(async () => {
    deleting.value = true;
    try {
      if (!(await w.removeTemplate(target.id))) {
        if (w.tenantId !== tenantId) return;
        Dialog.create({
          title: 'Template is in use',
          message: target.archived
            ? 'Remove this template from all packs in every event before deleting it.'
            : 'This template is used by a pack in your organisation. Archive it to hide it from new packs while keeping existing packs working, or remove it from all packs before deleting.',
          cancel: !target.archived,
          ok: { label: target.archived ? 'OK' : 'Archive', color: 'primary' },
        }).onOk(async () => {
          if (target.archived || w.tenantId !== tenantId) return;
          w.patchTemplate(target.id, { archived: true });
          await w.flush().catch(w.fail);
        });
      }
    } catch (e) {
      w.fail(e);
    } finally {
      deleting.value = false;
    }
  });
}
</script>
<template>
  <div class="workspace templates-workspace" :inert="deleting">
    <aside class="sidebar">
      <div class="section-heading">
        <span class="eyebrow">Templates</span
        ><q-btn
          outline
          dense
          icon="add"
          color="primary"
          aria-label="New template"
          :disable="!w.canEdit"
          @click="add()"
        />
      </div>
      <button
        v-for="t in visibleTemplates"
        :key="t.id"
        class="template-link"
        :class="{ selected: template?.id === t.id }"
        @click="selected = t.id"
      >
        <q-icon
          :name="t.orientation === 'landscape' ? 'crop_landscape' : 'crop_portrait'"
          size="22px"
        /><span
          ><strong>{{ t.name }}{{ t.archived ? ' (archived)' : '' }}</strong
          ><small
            >{{ t.orientation === 'landscape' ? 'Landscape' : 'Portrait' }} ·
            {{ styles.find((s) => s.value === t.itemStyle)?.label }}</small
          ></span
        >
      </button>
      <q-checkbox v-model="showArchived" label="Show archived" dense class="q-mt-md" />
    </aside>
    <main class="workspace-main" v-if="template">
      <div class="section-heading template-heading">
        <div>
          <q-input
            class="heading-input"
            :model-value="template.name"
            borderless
            dense
            :readonly="!w.canEdit"
            aria-label="Template name"
            @update:model-value="(v) => v && patch({ name: String(v) })"
          />
          <p>Used in {{ usage }} packs in this event</p>
        </div>
        <div class="button-row">
          <q-btn
            flat
            no-caps
            color="negative"
            label="Delete"
            aria-label="Delete template"
            :disable="!w.canEdit"
            :loading="deleting"
            @click="removeTemplate"
          />
          <q-btn
            v-if="template.archived"
            flat
            no-caps
            label="Unarchive"
            :disable="!w.canEdit || deleting"
            @click="patch({ archived: false })"
          />
          <q-btn outline no-caps label="Duplicate" :disable="!w.canEdit" @click="add(true)" /><q-btn
            color="primary"
            no-caps
            label="Save template"
            :disable="!w.canEdit"
            @click="save"
          />
        </div>
      </div>
      <fieldset :disabled="!w.canEdit || deleting" class="template-sections">
        <section class="card">
          <h2>Page</h2>
          <div class="three-fields">
            <label
              >Orientation<q-btn-toggle
                :model-value="template.orientation"
                spread
                no-caps
                unelevated
                toggle-color="white"
                toggle-text-color="dark"
                color="grey-2"
                text-color="grey-8"
                :options="[
                  { label: 'Portrait', value: 'portrait' },
                  { label: 'Landscape', value: 'landscape' },
                ]"
                @update:model-value="(v) => patch({ orientation: v })" /></label
            ><label
              >Page size<q-input outlined dense model-value="A4" readonly
                ><template #prepend
                  ><q-icon name="lock_outline" size="16px" /></template></q-input></label
            ><label
              >Page count<q-select
                outlined
                dense
                :model-value="template.pageMode.kind"
                :options="[
                  { label: 'Flow as needed', value: 'flow' },
                  { label: 'Fit to N pages', value: 'fit' },
                ]"
                emit-value
                map-options
                @update:model-value="
                  (v) =>
                    patch({ pageMode: v === 'flow' ? { kind: 'flow' } : { kind: 'fit', pages: 1 } })
                "
            /></label>
          </div>
          <q-input
            v-if="template.pageMode.kind === 'fit'"
            outlined
            dense
            type="number"
            label="Target pages"
            :model-value="template.pageMode.pages"
            min="1"
            max="100"
            @update:model-value="
              (v) =>
                patch({ pageMode: { kind: 'fit', pages: Math.max(1, Math.min(100, Number(v))) } })
            "
          />
        </section>
        <section class="card">
          <div class="section-heading">
            <h2>Header</h2>
            <q-select
              :model-value="template.headerPages ?? 'all'"
              label="Show header on"
              outlined
              dense
              emit-value
              map-options
              :options="[
                { label: 'All pages', value: 'all' },
                { label: 'First page only', value: 'first' },
              ]"
              @update:model-value="(v) => patch({ headerPages: v })"
            />
          </div>
          <div class="header-options">
            <div v-for="(label, key) in headers" :key="key" class="header-option">
              <q-checkbox
                :model-value="template.header[key].show"
                :label="label"
                dense
                size="sm"
                @update:model-value="(v) => header(key, 'show', v)"
              /><select
                :value="template.header[key].align"
                :aria-label="label + ' alignment'"
                @change="header(key, 'align', ($event.target as HTMLSelectElement).value)"
              >
                <option value="left">Left</option>
                <option v-if="key === 'logo'" value="center">Centre</option>
                <option value="right">Right</option>
              </select>
            </div>
          </div>
        </section>
        <section class="card">
          <h2>Item style</h2>
          <div class="style-options">
            <button
              v-for="s in styles"
              :key="s.value"
              class="style-option"
              :class="{ selected: template.itemStyle === s.value }"
              :aria-pressed="template.itemStyle === s.value"
              @click="patch({ itemStyle: s.value })"
            >
              <q-icon :name="s.icon" size="40px" /><strong>{{ s.label }}</strong>
            </button>
          </div>
        </section>
        <div class="template-lower">
          <section class="card">
            <div class="section-heading">
              <h2>Columns</h2>
              <small class="muted">Drag to reorder</small>
            </div>
            <div class="column-options">
              <div
                v-for="(c, index) in template.columns"
                :key="c.key"
                class="column-option"
                @dragover.prevent
                @drop.prevent="reorder(index)"
              >
                <span class="drag-handle" draggable="true" @dragstart="dragIndex = index">⠿</span
                ><q-checkbox
                  :model-value="c.visible"
                  :label="labels[c.key]"
                  dense
                  size="sm"
                  @update:model-value="(v) => column(index, 'visible', v)"
                /><input
                  :value="c.width"
                  :aria-label="labels[c.key] + ' width'"
                  @change="column(index, 'width', ($event.target as HTMLInputElement).value)"
                />
              </div>
            </div>
          </section>
          <section class="card">
            <h2>Which items</h2>
            <div class="scope-options">
              <q-radio
                :model-value="template.filter.scope"
                val="all"
                label="All items"
                @update:model-value="(v) => patch({ filter: { ...template!.filter, scope: v } })"
              /><q-radio
                :model-value="template.filter.scope"
                val="recipient"
                label="Only the recipient’s items"
                @update:model-value="(v) => patch({ filter: { ...template!.filter, scope: v } })"
              /><q-radio
                :model-value="template.filter.scope"
                val="recipientPlusNeighbours"
                label="Recipient’s items + one either side"
                @update:model-value="(v) => patch({ filter: { ...template!.filter, scope: v } })"
              />
            </div>
            <label>Categories</label>
            <div class="category-options">
              <button
                v-for="c in w.categories"
                :key="c.id"
                class="pill"
                :class="{
                  excluded:
                    template.filter.categoryIds !== null &&
                    !template.filter.categoryIds.includes(c.id),
                }"
                :style="{ background: c.bg, color: c.fg }"
                @click="toggleCategory(c.id)"
              >
                {{ c.name }}
              </button>
            </div>
            <small class="muted"
              >{{
                template.filter.categoryIds === null
                  ? 'All ' + w.categories.length
                  : template.filter.categoryIds.length
              }}
              included</small
            >
          </section>
        </div>
      </fieldset>
    </main>
    <main v-else class="workspace-main empty-state">
      <h1>No templates</h1>
      <p>Create a template using the + button, or show archived templates.</p>
    </main>
    <aside class="preview-panel">
      <div class="section-heading">
        <h3>Preview</h3>
        <q-select
          v-model="personId"
          :options="[{ id: '', name: '[Person name]' }, ...w.people]"
          option-label="name"
          option-value="id"
          emit-value
          map-options
          outlined
          dense
          aria-label="Preview as person"
        />
      </div>
      <q-select
        class="preview-session"
        :model-value="w.sessionId"
        :options="w.sessions"
        option-label="name"
        option-value="id"
        emit-value
        map-options
        outlined
        dense
        aria-label="Preview session"
        @update:model-value="w.selectSession"
      /><PrintPreview :payload="preview" />
    </aside>
  </div>
</template>

<style scoped>
.style-options {
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
}
</style>
