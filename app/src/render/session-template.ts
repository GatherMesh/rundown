import type { ColumnKey, Template } from '../types';
import { labels } from './renderer';

export const sessionRunsheetTemplate: Template = {
  id: 'session-runsheet',
  name: 'Full runsheet',
  orientation: 'portrait',
  paper: 'A4',
  pageMode: { kind: 'flow' },
  header: {
    sessionName: { show: true, align: 'left' },
    eventName: { show: true, align: 'left' },
    sessionDateTime: { show: true, align: 'right' },
    logo: { show: true, align: 'left' },
    sessionSubtitle: { show: false, align: 'left' },
    personName: { show: false, align: 'right' },
  },
  itemStyle: 'cards',
  columns: (Object.keys(labels) as ColumnKey[]).map((key) => ({
    key,
    visible: true,
    width: 'auto',
  })),
  filter: { scope: 'all', categoryIds: null },
};
