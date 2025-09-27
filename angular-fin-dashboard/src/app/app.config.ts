import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';
import { provideStore } from '@ngrx/store';
import { DASHBOARD_FEATURE_KEY, dashboardReducer } from './state/dashboard.reducer';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideStore({ [DASHBOARD_FEATURE_KEY]: dashboardReducer })
  ]
};
