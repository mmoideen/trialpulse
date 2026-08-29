metadata description = 'Azure Monitor action group, the three alert rules required by PRD section 8.4 (P99 latency > 5s, error rate > 1%, daily cost over threshold) and an Azure Consumption budget on the resource group.'

@description('Azure region for the alert rules. Scheduled query rules are regional; the action group is global.')
param location string

@description('Tags applied to the alert resources.')
param tags object

@description('Short name for the action group. 12 characters maximum, shown as the SMS/e-mail sender.')
@maxLength(12)
param actionGroupShortName string = 'trialpulse'

@description('Name of the action group.')
param actionGroupName string

@description('E-mail addresses notified by every alert. Use a distribution list, not an individual.')
param alertEmailAddresses array = []

@description('Resource id of the Application Insights component the query rules run against.')
param appInsightsId string

@description('P99 latency threshold in milliseconds. PRD section 6.3 target is under 5000 ms.')
param p99LatencyThresholdMs int = 5000

@description('Error-rate threshold as a percentage of requests. PRD section 8.4 target is under 1%.')
param errorRatePercentThreshold int = 1

@description('Rolling 24-hour model-spend threshold in USD that triggers the cost alert. Distinct from the Azure Consumption budget, which covers infrastructure spend.')
param dailyModelCostThresholdUsd int = 20

@description('Name of the custom metric the orchestrator emits for per-query cost. MUST match the telemetry emitted by packages/orchestrator; see docs/runbook.md before go-live.')
param costMetricName string = 'trialpulse.query.cost_usd'

@description('Application Insights operation name for the query endpoint, used by the latency and error-rate rules.')
param queryOperationName string = 'POST /api/query'

@description('Create an Azure Consumption budget scoped to this resource group.')
param enableBudget bool = true

@description('Monthly infrastructure budget in USD. PRD section 10 targets under 300 USD/month; docs/cost-model.md explains why that is optimistic.')
param monthlyBudgetUsd int = 300

@description('Budget start date, first day of a month in yyyy-MM-dd form.')
param budgetStartDate string = utcNow('yyyy-MM-01')

@description('Budget end date in yyyy-MM-dd form. Azure requires an explicit end date.')
param budgetEndDate string = '2030-01-01'

var emailReceivers = [
  for (address, index) in alertEmailAddresses: {
    name: 'email-${index}'
    emailAddress: address
    useCommonAlertSchema: true
  }
]

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: actionGroupName
  location: 'global'
  tags: tags
  properties: {
    groupShortName: actionGroupShortName
    enabled: true
    emailReceivers: emailReceivers
  }
}

resource p99LatencyAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-p99-latency'
  location: location
  tags: tags
  properties: {
    displayName: 'TrialPulse P99 query latency above target'
    description: 'PRD section 6.3 sets a P99 of 5 seconds for POST /api/query. Two consecutive failing 15-minute windows are required so that a single slow cold start does not page anyone.'
    severity: 2
    enabled: true
    scopes: [
      appInsightsId
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: 'requests\n| where name == "${queryOperationName}"\n| summarize p99_latency_ms = percentile(duration, 99) by bin(timestamp, 5m)'
          timeAggregation: 'Maximum'
          metricMeasureColumn: 'p99_latency_ms'
          operator: 'GreaterThan'
          threshold: p99LatencyThresholdMs
          failingPeriods: {
            numberOfEvaluationPeriods: 2
            minFailingPeriodsToAlert: 2
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
  }
}

resource errorRateAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-error-rate'
  location: location
  tags: tags
  properties: {
    displayName: 'TrialPulse request error rate above target'
    description: 'PRD section 8.4: alert when more than 1% of requests fail. A refusal is a successful request and is deliberately not counted as an error.'
    severity: 1
    enabled: true
    scopes: [
      appInsightsId
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: 'requests\n| summarize total = count(), failed = countif(success == false)\n| extend error_rate_percent = todouble(failed) * 100.0 / todouble(max_of(total, 1))\n| project error_rate_percent'
          timeAggregation: 'Maximum'
          metricMeasureColumn: 'error_rate_percent'
          operator: 'GreaterThan'
          threshold: errorRatePercentThreshold
          failingPeriods: {
            numberOfEvaluationPeriods: 2
            minFailingPeriodsToAlert: 2
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
  }
}

resource dailyCostAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-daily-model-cost'
  location: location
  tags: tags
  properties: {
    displayName: 'TrialPulse rolling 24-hour model spend above threshold'
    description: 'Denial-of-wallet and runaway-loop detection. Reads the per-query cost metric the orchestrator emits, so it fires long before the monthly Azure invoice reflects the problem.'
    severity: 2
    enabled: true
    scopes: [
      appInsightsId
    ]
    evaluationFrequency: 'PT1H'
    windowSize: 'P1D'
    criteria: {
      allOf: [
        {
          query: 'customMetrics\n| where name == "${costMetricName}"\n| summarize daily_cost_usd = sum(valueSum)'
          timeAggregation: 'Maximum'
          metricMeasureColumn: 'daily_cost_usd'
          operator: 'GreaterThan'
          threshold: dailyModelCostThresholdUsd
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
  }
}

resource budget 'Microsoft.Consumption/budgets@2023-05-01' = if (enableBudget) {
  name: 'budget-trialpulse'
  properties: {
    category: 'Cost'
    amount: monthlyBudgetUsd
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: budgetStartDate
      endDate: budgetEndDate
    }
    notifications: {
      forecasted100Percent: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: alertEmailAddresses
        contactGroups: [
          actionGroup.id
        ]
      }
      actual80Percent: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: alertEmailAddresses
        contactGroups: [
          actionGroup.id
        ]
      }
      actual100Percent: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 100
        thresholdType: 'Actual'
        contactEmails: alertEmailAddresses
        contactGroups: [
          actionGroup.id
        ]
      }
    }
  }
}

@description('Resource id of the action group every alert routes to.')
output actionGroupId string = actionGroup.id

@description('Names of the scheduled query rules created.')
output alertRuleNames array = [
  p99LatencyAlert.name
  errorRateAlert.name
  dailyCostAlert.name
]
