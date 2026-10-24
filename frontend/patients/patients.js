import { mountHeader } from '../shared/ui.js';

// Shared frame only. No queue snapshots or operations are simulated.
mountHeader(document.getElementById('app-header'), { area: 'provider', page: 'patients' });
