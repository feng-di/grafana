import { find, startsWith } from 'lodash';

import { DataSourceInstanceSettings, ScopedVars } from '@grafana/data';
import { DataSourceWithBackend, getTemplateSrv, TemplateSrv } from '@grafana/runtime';
import { getTimeSrv, TimeSrv } from 'app/features/dashboard/services/TimeSrv';

import { getAuthType, getAzureCloud, getAzurePortalUrl } from '../credentials';
import TimegrainConverter from '../time_grain_converter';
import {
  AzureDataSourceJsonData,
  AzureMonitorMetricNamespacesResponse,
  AzureMonitorMetricNamesResponse,
  AzureMonitorMetricsMetadataResponse,
  AzureMonitorQuery,
  AzureMonitorResourceGroupsResponse,
  AzureQueryType,
  DatasourceValidationResult,
  GetMetricNamespacesQuery,
  GetMetricNamesQuery,
  GetMetricMetadataQuery,
  AzureMetricQuery,
} from '../types';
import { routeNames } from '../utils/common';
import migrateQuery from '../utils/migrateQuery';

import ResponseParser from './response_parser';
import UrlBuilder from './url_builder';

const defaultDropdownValue = 'select';

function hasValue(item?: string) {
  return !!(item && item !== defaultDropdownValue);
}

export default class AzureMonitorDatasource extends DataSourceWithBackend<AzureMonitorQuery, AzureDataSourceJsonData> {
  apiVersion = '2018-01-01';
  apiPreviewVersion = '2017-12-01-preview';
  listByResourceGroupApiVersion = '2021-04-01';
  defaultSubscriptionId?: string;
  resourcePath: string;
  azurePortalUrl: string;
  declare resourceGroup: string;
  declare resourceName: string;
  timeSrv: TimeSrv;
  templateSrv: TemplateSrv;

  constructor(private instanceSettings: DataSourceInstanceSettings<AzureDataSourceJsonData>) {
    super(instanceSettings);

    this.timeSrv = getTimeSrv();
    this.templateSrv = getTemplateSrv();
    this.defaultSubscriptionId = instanceSettings.jsonData.subscriptionId;

    const cloud = getAzureCloud(instanceSettings);
    this.resourcePath = routeNames.azureMonitor;
    this.azurePortalUrl = getAzurePortalUrl(cloud);
  }

  isConfigured(): boolean {
    // If validation didn't return any error then the data source is properly configured
    return !this.validateDatasource();
  }

  filterQuery(item: AzureMonitorQuery): boolean {
    const hasResourceUri = !!item?.azureMonitor?.resourceUri;
    const hasLegacyQuery =
      hasValue(item?.azureMonitor?.resourceGroup) &&
      hasValue(item?.azureMonitor?.resourceName) &&
      hasValue(item?.azureMonitor?.metricDefinition || item?.azureMonitor?.metricNamespace);

    return !!(
      item.hide !== true &&
      (hasResourceUri || hasLegacyQuery) &&
      hasValue(item?.azureMonitor?.metricName) &&
      hasValue(item?.azureMonitor?.aggregation)
    );
  }

  applyTemplateVariables(target: AzureMonitorQuery, scopedVars: ScopedVars): AzureMonitorQuery {
    const item = target.azureMonitor;

    if (!item) {
      // return target;
      throw new Error('Query is not a valid Azure Monitor Metrics query');
    }

    // fix for timeGrainUnit which is a deprecated/removed field name
    if (item.timeGrain && item.timeGrainUnit && item.timeGrain !== 'auto') {
      item.timeGrain = TimegrainConverter.createISO8601Duration(item.timeGrain, item.timeGrainUnit);
    }

    const templateSrv = getTemplateSrv();

    const resourceUri = templateSrv.replace(item.resourceUri, scopedVars);
    const subscriptionId = templateSrv.replace(target.subscription || this.defaultSubscriptionId, scopedVars);
    const resourceGroup = templateSrv.replace(item.resourceGroup, scopedVars);
    const resourceName = templateSrv.replace(item.resourceName, scopedVars);
    const metricNamespace = templateSrv.replace(item.metricNamespace, scopedVars);
    const timeGrain = templateSrv.replace((item.timeGrain || '').toString(), scopedVars);
    const aggregation = templateSrv.replace(item.aggregation, scopedVars);
    const top = templateSrv.replace(item.top || '', scopedVars);

    const dimensionFilters = (item.dimensionFilters ?? [])
      .filter((f) => f.dimension && f.dimension !== 'None')
      .map((f) => {
        const filters = f.filters?.map((filter) => templateSrv.replace(filter ?? '', scopedVars));
        return {
          dimension: templateSrv.replace(f.dimension, scopedVars),
          operator: f.operator || 'eq',
          filters: filters || [],
        };
      });

    const azMonitorQuery: AzureMetricQuery = {
      resourceUri,
      resourceGroup,
      metricNamespace,
      resourceName,
      timeGrain,
      allowedTimeGrainsMs: item.allowedTimeGrainsMs,
      metricName: templateSrv.replace(item.metricName, scopedVars),
      aggregation: aggregation,
      dimensionFilters,
      top: top || '10',
      alias: item.alias,
    };
    if (item.metricDefinition) {
      azMonitorQuery.metricDefinition = templateSrv.replace(item.metricDefinition, scopedVars);
    }

    return migrateQuery(
      {
        ...target,
        subscription: subscriptionId,
        queryType: AzureQueryType.AzureMonitor,
        azureMonitor: azMonitorQuery,
      },
      templateSrv
    );
  }

  async getSubscriptions(): Promise<Array<{ text: string; value: string }>> {
    if (!this.isConfigured()) {
      return [];
    }

    return this.getResource(`${this.resourcePath}/subscriptions?api-version=2019-03-01`).then((result: any) => {
      return ResponseParser.parseSubscriptions(result);
    });
  }

  getResourceGroups(subscriptionId: string) {
    return this.getResource(
      `${this.resourcePath}/subscriptions/${subscriptionId}/resourceGroups?api-version=${this.listByResourceGroupApiVersion}`
    ).then((result: AzureMonitorResourceGroupsResponse) => {
      return ResponseParser.parseResponseValues(result, 'name', 'name');
    });
  }

  getResourceNames(subscriptionId: string, resourceGroup?: string, metricNamespace?: string, skipToken?: string) {
    const validMetricNamespace = startsWith(metricNamespace, 'Microsoft.Storage/storageAccounts/')
      ? 'Microsoft.Storage/storageAccounts'
      : metricNamespace;
    let url = `${this.resourcePath}/subscriptions/${subscriptionId}`;
    if (resourceGroup) {
      url += `/resourceGroups/${resourceGroup}`;
    }
    url += `/resources?api-version=${this.listByResourceGroupApiVersion}`;
    if (validMetricNamespace) {
      url += `&$filter=resourceType eq '${validMetricNamespace}'`;
    }
    if (skipToken) {
      url += `&$skiptoken=${skipToken}`;
    }
    return this.getResource(url).then(async (result: any) => {
      let list: Array<{ text: string; value: string }> = [];
      if (startsWith(metricNamespace, 'Microsoft.Storage/storageAccounts/')) {
        list = ResponseParser.parseResourceNames(result, 'Microsoft.Storage/storageAccounts');
        for (let i = 0; i < list.length; i++) {
          list[i].text += '/default';
          list[i].value += '/default';
        }
      } else {
        list = ResponseParser.parseResourceNames(result, metricNamespace);
      }

      if (result.nextLink) {
        // If there is a nextLink, we should request more pages
        const nextURL = new URL(result.nextLink);
        const nextToken = nextURL.searchParams.get('$skiptoken');
        if (!nextToken) {
          throw Error('unable to request the next page of resources');
        }
        const nextPage = await this.getResourceNames(subscriptionId, resourceGroup, metricNamespace, nextToken);
        list = list.concat(nextPage);
      }

      return list;
    });
  }

  getMetricNamespaces(query: GetMetricNamespacesQuery) {
    const url = UrlBuilder.buildAzureMonitorGetMetricNamespacesUrl(
      this.resourcePath,
      this.apiPreviewVersion,
      this.replaceTemplateVariables(query),
      this.templateSrv
    );
    return this.getResource(url)
      .then((result: AzureMonitorMetricNamespacesResponse) => {
        return ResponseParser.parseResponseValues(
          result,
          'properties.metricNamespaceName',
          'properties.metricNamespaceName'
        );
      })
      .then((result) => {
        if (url.includes('Microsoft.Storage/storageAccounts')) {
          const storageNamespaces = [
            'Microsoft.Storage/storageAccounts',
            'Microsoft.Storage/storageAccounts/blobServices',
            'Microsoft.Storage/storageAccounts/fileServices',
            'Microsoft.Storage/storageAccounts/tableServices',
            'Microsoft.Storage/storageAccounts/queueServices',
          ];
          for (const namespace of storageNamespaces) {
            if (!find(result, ['value', namespace.toLowerCase()])) {
              result.push({ value: namespace, text: namespace });
            }
          }
        }
        return result;
      });
  }

  getMetricNames(query: GetMetricNamesQuery) {
    const url = UrlBuilder.buildAzureMonitorGetMetricNamesUrl(
      this.resourcePath,
      this.apiVersion,
      this.replaceTemplateVariables(query),
      this.templateSrv
    );
    return this.getResource(url).then((result: AzureMonitorMetricNamesResponse) => {
      return ResponseParser.parseResponseValues(result, 'name.localizedValue', 'name.value');
    });
  }

  getMetricMetadata(query: GetMetricMetadataQuery) {
    const { metricName } = query;
    const url = UrlBuilder.buildAzureMonitorGetMetricNamesUrl(
      this.resourcePath,
      this.apiVersion,
      this.replaceTemplateVariables(query),
      this.templateSrv
    );
    return this.getResource(url).then((result: AzureMonitorMetricsMetadataResponse) => {
      return ResponseParser.parseMetadata(result, metricName);
    });
  }

  private validateDatasource(): DatasourceValidationResult | undefined {
    const authType = getAuthType(this.instanceSettings);

    if (authType === 'clientsecret') {
      if (!this.isValidConfigField(this.instanceSettings.jsonData.tenantId)) {
        return {
          status: 'error',
          message: 'The Tenant Id field is required.',
        };
      }

      if (!this.isValidConfigField(this.instanceSettings.jsonData.clientId)) {
        return {
          status: 'error',
          message: 'The Client Id field is required.',
        };
      }
    }

    return undefined;
  }

  private isValidConfigField(field?: string): boolean {
    return typeof field === 'string' && field.length > 0;
  }

  private replaceTemplateVariables<T extends { [K in keyof T]: string }>(query: T) {
    const templateSrv = getTemplateSrv();

    const workingQuery: { [K in keyof T]: string } = { ...query };
    const keys = Object.keys(query) as Array<keyof T>;
    keys.forEach((key) => {
      workingQuery[key] = templateSrv.replace(workingQuery[key]);
    });

    return workingQuery;
  }
}
