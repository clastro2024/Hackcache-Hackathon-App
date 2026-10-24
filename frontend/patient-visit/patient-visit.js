import { mountHeader } from '../shared/ui.js';

// Shared frame only. No visit data, patient decisions or reviewed output is simulated.
mountHeader(document.getElementById('app-header'), { area: 'patient' });
