<script setup lang="ts">
import { ref } from 'vue';
import { useWorkspace } from '../stores/workspace';
import { Temporal } from '@js-temporal/polyfill';
const w = useWorkspace(),
  open = ref(false),
  editing = ref(false),
  name = ref(''),
  start = ref(''),
  end = ref(''),
  zone = ref('Australia/Brisbane'),
  venue = ref('');
function show(edit = false) {
  editing.value = edit;
  name.value = edit ? (w.event?.name ?? '') : '';
  start.value = edit ? (w.event?.startDate ?? '') : '';
  end.value = edit ? (w.event?.endDate ?? '') : '';
  zone.value = edit ? (w.event?.timeZone ?? 'Australia/Brisbane') : 'Australia/Brisbane';
  venue.value = edit ? (w.event?.venue ?? '') : '';
  open.value = true;
}
async function save() {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone.value });
    Temporal.PlainDate.from(start.value);
    Temporal.PlainDate.from(end.value);
    if (end.value < start.value) throw new Error('End date must be on or after the start date.');
    const data = {
      name: name.value.trim(),
      startDate: start.value,
      endDate: end.value,
      timeZone: zone.value,
      venue: venue.value,
    };
    if (editing.value) await w.saveEvent(data);
    else await w.addEvent(data);
    open.value = false;
  } catch (e) {
    w.fail(e);
  }
}
async function logo(files: FileList | null) {
  if (!files?.[0]) return;
  try {
    const image = await w.uploadImage(files[0], `${w.eventPath()}/logo`);
    await w.saveEvent({ logo: image });
  } catch (e) {
    w.fail(e);
  }
}
</script>
<template>
  <div class="event-picker">
    <label class="eyebrow">Event</label
    ><q-select
      :model-value="w.eventId"
      :options="w.events"
      option-label="name"
      option-value="id"
      emit-value
      map-options
      outlined
      dense
      @update:model-value="w.selectEvent"
      aria-label="Select event"
    />
    <div class="event-actions">
      <q-btn
        flat
        dense
        no-caps
        size="sm"
        label="New event"
        icon="add"
        :disable="!w.canEdit"
        @click="show()"
      /><q-btn
        v-if="w.event"
        flat
        dense
        no-caps
        size="sm"
        label="Edit"
        :disable="!w.canEdit"
        @click="show(true)"
      />
    </div>
  </div>
  <q-dialog v-model="open"
    ><q-card class="dialog-card"
      ><q-card-section
        ><h2>{{ editing ? 'Edit event' : 'New event' }}</h2></q-card-section
      ><q-form @submit="save"
        ><q-card-section class="form-stack"
          ><q-input
            v-model="name"
            outlined
            label="Event name"
            :rules="[(v) => !!v.trim() || 'Name is required']" />
          <div class="two-fields">
            <q-input v-model="start" outlined type="date" label="First day" required /><q-input
              v-model="end"
              outlined
              type="date"
              label="Last day"
              required
            />
          </div>
          <q-input
            v-model="zone"
            outlined
            label="Time zone"
            hint="IANA name, e.g. Australia/Brisbane" /><q-input
            v-model="venue"
            outlined
            label="Venue" /><label v-if="editing" class="upload-label"
            >Event logo (PNG/JPG)<input
              type="file"
              accept="image/png,image/jpeg"
              @change="logo(($event.target as HTMLInputElement).files)" /></label></q-card-section
        ><q-card-actions align="right"
          ><q-btn flat label="Cancel" v-close-popup /><q-btn
            color="primary"
            label="Save event"
            no-caps
            type="submit" /></q-card-actions></q-form></q-card
  ></q-dialog>
</template>
