#!/bin/bash
# HobbyIQ Azure Smoke Test
# Usage: bash scripts/smoke-test-azure.sh <API_BASE_URL>

set -e

API_URL=${1:-"https://<your-app-service-name>.azurewebsites.net"}

function check_endpoint() {
  local endpoint=$1
  echo "Testing $API_URL$endpoint ..."
  http_code=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL$endpoint")
  if [[ "$http_code" == "200" ]]; then
    echo "PASS: $endpoint returned 200"
  else
    echo "FAIL: $endpoint returned $http_code"
    exit 1
  fi
}

# Main API health
check_endpoint "/api/health"

# Pricing endpoint basic check
check_endpoint "/api/pricing/estimate"

echo "All smoke tests passed!"
