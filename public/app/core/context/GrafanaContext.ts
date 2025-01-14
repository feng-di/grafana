import React, { useContext } from 'react';

import { GrafanaConfig } from '@grafana/data';
import { LocationService } from '@grafana/runtime/src/services/LocationService';
import { BackendSrv } from '@grafana/runtime/src/services/backendSrv';

import { AppChromeService } from '../components/AppChrome/AppChromeService';

export interface GrafanaContextType {
  backend: BackendSrv;
  location: LocationService;
  config: GrafanaConfig;
  chrome: AppChromeService;
}

export const GrafanaContext = React.createContext<GrafanaContextType | undefined>(undefined);

export function useGrafana(): GrafanaContextType {
  const context = useContext(GrafanaContext);
  if (!context) {
    throw new Error('No GrafanaContext found');
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return context as GrafanaContextType;
}
