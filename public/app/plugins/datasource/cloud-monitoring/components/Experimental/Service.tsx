import React, { useEffect, useState } from 'react';

import { SelectableValue } from '@grafana/data';
import { EditorField, EditorRow, Select } from '@grafana/ui';

import CloudMonitoringDatasource from '../../datasource';
import { SLOQuery } from '../../types';

export interface Props {
  refId: string;
  onChange: (query: SLOQuery) => void;
  query: SLOQuery;
  templateVariableOptions: Array<SelectableValue<string>>;
  datasource: CloudMonitoringDatasource;
}

export const Service: React.FC<Props> = ({ refId, query, templateVariableOptions, onChange, datasource }) => {
  const [services, setServices] = useState<Array<SelectableValue<string>>>([]);
  const { projectName } = query;

  useEffect(() => {
    if (!projectName) {
      return;
    }

    datasource.getSLOServices(projectName).then((services: Array<SelectableValue<string>>) => {
      setServices([
        {
          label: 'Template Variables',
          options: templateVariableOptions,
        },
        ...services,
      ]);
    });
  }, [datasource, projectName, templateVariableOptions]);

  return (
    <EditorRow>
      <EditorField label="Service">
        <Select
          inputId={`${refId}-slo-service`}
          width="auto"
          allowCustomValue
          value={query?.serviceId && { value: query?.serviceId, label: query?.serviceName || query?.serviceId }}
          placeholder="Select service"
          options={services}
          onChange={({ value: serviceId = '', label: serviceName = '' }) =>
            onChange({ ...query, serviceId, serviceName, sloId: '' })
          }
        />
      </EditorField>
    </EditorRow>
  );
};
