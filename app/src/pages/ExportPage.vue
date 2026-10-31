<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue';
import { httpsCallable } from 'firebase/functions';
import { doc, onSnapshot } from 'firebase/firestore';
import { getBlob, ref as storageRef } from 'firebase/storage';
import { Notify } from 'quasar';
import { functions, db, storage } from '../boot/firebase';
import { useWorkspace } from '../stores/workspace';
import { payload } from '../render/payload';
import { renderDocument } from '../render/renderer';
import { planPack } from '../render/domain';
import type { PackSettings, Person } from '../types';
const w = useWorkspace(),
  selected = ref('margaret'),
  counts = ref<Record<string, Record<string, number>>>({}),
  busy = ref(false),
  calculating = ref(false),
  progress = ref(''),
  warning = ref(''),
  drag = ref(-1),
  addTemplateId = ref(''),
  pdfUrl = ref(''),
  pdfOpen = ref(false);
const person = computed(() => w.people.find((p) => p.id === selected.value) ?? w.people[0]);
const sidesOptions = [
  { label: 'Single', value: 'single' },
  { label: 'Double · long edge', value: 'duplexLong' },
  { label: 'Double · short edge', value: 'duplexShort' },
];
const scalingOptions = [
  { label: 'Fit to A4', value: 'fit', icon: 'fit_screen' },
  { label: 'Actual size', value: 'actual', icon: 'crop_original' },
  { label: '2 per sheet', value: '2up', icon: 'view_column' },
  { label: '4 per sheet', value: '4up', icon: 'grid_view' },
];
function plan(p: Person) {
  try {
    return planPack(p.pack, counts.value[p.id] ?? {});
  } catch {
    return null;
  }
}
const totalSheets = computed(() =>
  w.people.filter((p) => p.pack.enabled).reduce((n, p) => n + (plan(p)?.sheets ?? 0), 0),
);
function patch(part: Partial<PackSettings>, p = person.value) {
  if (p) w.patchPerson(p.id, { pack: { ...p.pack, ...part } });
}
function copies(index: number, delta: number) {
  if (!person.value) return;
  const templates = person.value.pack.templates.map((t) => ({ ...t }));
  templates[index].copies = Math.max(1, Math.min(20, templates[index].copies + delta));
  patch({ templates });
}
function remove(index: number) {
  patch({ templates: person.value!.pack.templates.filter((_, i) => i !== index) });
}
function add() {
  if (!addTemplateId.value || !person.value) return;
  if (!w.templates.some((t) => t.id === addTemplateId.value && !t.archived)) return;
  patch({
    templates: [...person.value.pack.templates, { templateId: addTemplateId.value, copies: 1 }],
  });
  addTemplateId.value = '';
}
function reorder(index: number) {
  if (!person.value) return;
  const refs = [...person.value.pack.templates],
    moved = refs.splice(drag.value, 1)[0];
  refs.splice(index, 0, moved);
  patch({ templates: refs });
}
let timer: ReturnType<typeof setTimeout>,
  version = 0;
watch(
  () =>
    JSON.stringify([
      w.orderedItems,
      w.templates,
      w.people.map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        templates: p.pack.templates.map((t) => t.templateId),
      })),
      w.session,
      w.event,
      w.tenant,
    ]),
  () => {
    const run = ++version;
    clearTimeout(timer);
    calculating.value = true;
    counts.value = {};
    timer = setTimeout(async () => {
      if (!w.session) {
        calculating.value = false;
        return;
      }
      const next: Record<string, Record<string, number>> = {},
        warnings = new Set<string>();
      try {
        for (const p of w.people) {
          next[p.id] = {};
          for (const t of p.pack.templates) {
            if (run !== version) return;
            const template = w.templates.find((v) => v.id === t.templateId);
            if (!template)
              throw new Error('A pack references a missing template. Remove it or select another.');
            const r = await renderDocument(payload(w, template, p));
            next[p.id][t.templateId] = r.pageCount;
            if (r.warning) warnings.add(`${p.name}: ${r.warning}`);
          }
        }
        if (run === version) {
          counts.value = next;
          warning.value = [...warnings].join(' · ');
        }
      } catch (e) {
        if (run === version) warning.value = String(e);
      } finally {
        if (run === version) calculating.value = false;
      }
    }, 400);
  },
  { immediate: true },
);
onUnmounted(() => {
  clearTimeout(timer);
  version++;
  if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value);
});
async function generate(action: 'download' | 'print' | 'preview', p?: Person) {
  if (!w.session) return;
  busy.value = true;
  progress.value = 'Preparing session packs…';
  const jobId = crypto.randomUUID();
  const stop = onSnapshot(
    doc(db, `${w.base()}/exportJobs/${jobId}`),
    (s) => {
      if (s.exists()) progress.value = s.data().message;
    },
    () => {},
  );
  try {
    await w.flush();
    const call = httpsCallable<
      Record<string, string>,
      { path: string; url?: string; warning?: string }
    >(functions, p ? 'renderPack' : 'renderAllPacks', { timeout: 300000 });
    const result = await call({
      tenantId: w.tenantId,
      eventId: w.eventId,
      sessionId: w.sessionId,
      jobId,
      ...(p ? { personId: p.id } : {}),
    });
    const blob = await getBlob(storageRef(storage, result.data.path));
    if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value);
    pdfUrl.value = URL.createObjectURL(blob);
    if (result.data.warning)
      Notify.create({ type: 'warning', message: result.data.warning, timeout: 10000 });
    if (action === 'download') {
      const a = document.createElement('a');
      a.href = pdfUrl.value;
      a.download = `${w.session.name}-${p?.name ?? 'all-packs'}.pdf`;
      a.click();
    } else if (action === 'preview') {
      pdfOpen.value = true;
    } else {
      Notify.create({
        message: p
          ? p.pack.sides === 'single'
            ? 'Print single-sided.'
            : `Print two-sided, flip on ${p.pack.sides === 'duplexShort' ? 'short' : 'long'} edge.`
          : 'Print two-sided, flip on long edge.',
        timeout: 12000,
      });
      const frame = document.createElement('iframe');
      frame.className = 'print-job-frame';
      frame.src = pdfUrl.value;
      document.body.append(frame);
      frame.onload = () => {
        try {
          frame.contentWindow?.focus();
          frame.contentWindow?.print();
        } catch {
          pdfOpen.value = true;
        }
      };
      setTimeout(() => {
        frame.remove();
      }, 120000);
      pdfOpen.value = true;
    }
  } catch (e) {
    w.fail(e);
  } finally {
    stop();
    busy.value = false;
    progress.value = '';
  }
}
const initials = (p: Person) =>
  p.initials ||
  p.name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join('');
</script>
<template>
  <div class="export-workspace">
    <main class="workspace-main">
      <div class="section-heading export-heading">
        <div>
          <h1>Session packs</h1>
          <div class="export-session">
            <span class="muted">For</span
            ><q-select
              :model-value="w.sessionId"
              :options="w.sessions"
              option-label="name"
              option-value="id"
              emit-value
              map-options
              outlined
              dense
              aria-label="Export session"
              @update:model-value="w.selectSession"
            />
          </div>
        </div>
        <div class="button-row">
          <span class="muted"
            ><strong>{{ w.people.filter((p) => p.pack.enabled).length }}</strong> of
            {{ w.people.length }} people ·
            <strong>{{ calculating ? '…' : totalSheets }}</strong> sheets</span
          ><q-btn
            outline
            no-caps
            label="Download all (PDF)"
            :loading="busy"
            :disable="!w.session || !w.people.some((p) => p.pack.enabled)"
            @click="generate('download')"
          /><q-btn
            color="primary"
            no-caps
            icon="print"
            label="Print all packs"
            :loading="busy"
            :disable="!w.session || !w.people.some((p) => p.pack.enabled)"
            @click="generate('print')"
          />
        </div>
      </div>
      <q-banner v-if="warning" class="bg-orange-1">{{ warning }}</q-banner
      ><q-banner v-if="busy" class="bg-blue-1" role="status"
        ><q-spinner class="q-mr-sm" />{{ progress }}</q-banner
      >
      <section class="card export-table-card">
        <div class="table-scroll">
          <table class="export-table">
            <thead>
              <tr>
                <th>Export</th>
                <th>Person</th>
                <th>Templates</th>
                <th>Sides</th>
                <th>Scaling</th>
                <th>Sheets</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="p in w.people"
                :key="p.id"
                :class="{ selected: person?.id === p.id, disabled: !p.pack.enabled }"
                tabindex="0"
                @click="selected = p.id"
                @keydown.enter="selected = p.id"
              >
                <td @click.stop>
                  <q-toggle
                    :model-value="p.pack.enabled"
                    :disable="!w.canEdit"
                    :aria-label="'Enable pack for ' + p.name"
                    size="sm"
                    @update:model-value="(v) => patch({ enabled: v }, p)"
                  />
                </td>
                <td>
                  <div class="person-identity">
                    <span class="person-avatar">{{ initials(p) }}</span>
                    <div>
                      <strong>{{ p.name }}</strong
                      ><small>{{ p.role || 'No role' }}</small>
                    </div>
                  </div>
                </td>
                <td>
                  <span v-for="(t, index) in p.pack.templates" :key="index" class="template-tag"
                    >{{
                      w.templates.find((v) => v.id === t.templateId)?.name || 'Missing template'
                    }}
                    ×{{ t.copies }}</span
                  ><span v-if="!p.pack.templates.length" class="muted">No templates selected</span>
                </td>
                <td>{{ p.pack.sides === 'single' ? 'Single' : 'Double' }}</td>
                <td>{{ scalingOptions.find((v) => v.value === p.pack.scaling)?.label }}</td>
                <td>{{ p.pack.enabled ? (plan(p)?.sheets ?? '…') : '—' }}</td>
                <td>
                  <q-btn
                    outline
                    no-caps
                    dense
                    label="Print"
                    :disable="busy || !p.pack.enabled || !p.pack.templates.length"
                    @click.stop="generate('print', p)"
                  />
                </td>
              </tr>
              <tr v-if="!w.people.length">
                <td colspan="7" class="empty-state">
                  Add people to this event before configuring session packs.
                  <router-link to="/people">Open People</router-link>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <p class="muted export-note">
        Each pack prints with the recipient’s name. Pack settings apply to every session in this
        event.
      </p>
    </main>
    <aside v-if="person" class="detail-panel pack-panel">
      <div class="person-identity pack-person">
        <span class="person-avatar">{{ initials(person) }}</span>
        <div>
          <h2>{{ person.name }}</h2>
          <small
            >{{ person.role }} · on
            {{ w.items.filter((i) => i.personIds.includes(person!.id)).length }} items</small
          >
        </div>
      </div>
      <fieldset :disabled="!w.canEdit" class="form-stack">
        <section>
          <label class="eyebrow">Templates in this pack</label>
          <div
            v-for="(r, index) in person.pack.templates"
            :key="index"
            class="pack-template"
            @dragover.prevent
            @drop.prevent="reorder(index)"
          >
            <span class="drag-handle" draggable="true" @dragstart="drag = index">⠿</span>
            <div class="pack-template-name">
              <strong>{{
                w.templates.find((t) => t.id === r.templateId)?.name || 'Missing template'
              }}</strong
              ><small
                >{{ w.templates.find((t) => t.id === r.templateId)?.orientation }} ·
                {{ counts[person.id]?.[r.templateId] ?? '…' }} pages</small
              >
            </div>
            <div class="copies-control">
              <button
                :aria-label="'Fewer copies of template ' + (index + 1)"
                @click="copies(index, -1)"
              >
                −</button
              ><span>×{{ r.copies }}</span
              ><button
                :aria-label="'More copies of template ' + (index + 1)"
                @click="copies(index, 1)"
              >
                +
              </button>
            </div>
            <q-btn
              flat
              round
              dense
              size="sm"
              icon="close"
              aria-label="Remove template from pack"
              @click="remove(index)"
            />
          </div>
          <div class="button-row">
            <q-select
              v-model="addTemplateId"
              :options="
                w.templates.filter(
                  (t) => !t.archived && !person!.pack.templates.some((r) => r.templateId === t.id),
                )
              "
              option-label="name"
              option-value="id"
              emit-value
              map-options
              outlined
              dense
              label="Add template"
            /><q-btn
              outline
              dense
              icon="add"
              aria-label="Add selected template"
              :disable="!addTemplateId"
              @click="add"
            />
          </div>
        </section>
        <section>
          <label class="eyebrow">Sides</label
          ><q-btn-toggle
            :model-value="person.pack.sides"
            :options="sidesOptions"
            spread
            no-caps
            unelevated
            color="grey-2"
            text-color="grey-8"
            toggle-color="white"
            toggle-text-color="dark"
            @update:model-value="(v) => patch({ sides: v })"
          />
        </section>
        <section>
          <label class="eyebrow">Scaling</label>
          <div class="scaling-options">
            <button
              v-for="s in scalingOptions"
              :key="s.value"
              class="style-option"
              :class="{ selected: person.pack.scaling === s.value }"
              @click="patch({ scaling: s.value as PackSettings['scaling'] })"
            >
              <q-icon :name="s.icon" size="28px" /><strong>{{ s.label }}</strong>
            </button>
          </div>
        </section>
        <section>
          <label class="eyebrow">Options</label>
          <div class="scope-options">
            <q-checkbox
              :model-value="person.pack.collate"
              label="Collate copies"
              @update:model-value="(v) => patch({ collate: v })"
            /><q-checkbox
              :model-value="person.pack.newSheetPerTemplate"
              label="Start each template on a new sheet"
              @update:model-value="(v) => patch({ newSheetPerTemplate: v })"
            /><q-checkbox
              :model-value="person.pack.coverSheet"
              label="Add a cover sheet with name"
              @update:model-value="(v) => patch({ coverSheet: v })"
            />
          </div>
        </section>
      </fieldset>
      <div class="pack-summary">
        <div>
          <span>Pages</span><strong>{{ plan(person)?.pages ?? '…' }}</strong>
        </div>
        <div>
          <span>Sheets ({{ person.pack.sides === 'single' ? 'single' : 'double' }}-sided)</span
          ><strong>{{ plan(person)?.sheets ?? '…' }}</strong>
        </div>
        <div class="button-row">
          <q-btn
            outline
            no-caps
            label="Preview PDF"
            :loading="busy"
            :disable="!person.pack.templates.length"
            @click="generate('preview', person)"
          /><q-btn
            color="primary"
            no-caps
            label="Print pack"
            :loading="busy"
            :disable="!person.pack.templates.length"
            @click="generate('print', person)"
          />
        </div>
      </div>
    </aside>
  </div>
  <q-dialog v-model="pdfOpen" maximized
    ><q-card class="pdf-dialog"
      ><q-card-section class="section-heading"
        ><h2>Session pack PDF</h2>
        <div class="button-row">
          <a :href="pdfUrl" target="_blank" rel="noopener">Open PDF in a new tab</a
          ><q-btn
            flat
            round
            icon="close"
            v-close-popup
            aria-label="Close PDF"
          /></div></q-card-section
      ><iframe :src="pdfUrl" title="Session pack PDF preview" /></q-card
  ></q-dialog>
</template>
