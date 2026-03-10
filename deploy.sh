#!/bin/bash
# deploy.sh — Deploy all FIS Cloud Functions to GCP
# Usage: ./deploy.sh [function_name]
#   function_name: sf_sync | claude_analysis | action_engine | complete_action | all (default: all)
set -e

PROJECT="water4-org"
REGION="us-central1"
RUNTIME="python313"
TARGET="${1:-all}"

echo "=== Water4 FIS — Deploy Cloud Functions ==="
echo "Project: $PROJECT | Region: $REGION"
echo ""

deploy_function() {
  local name="$1"
  local entry_point="$2"
  local source_dir="$3"
  local schedule="$4"
  local memory="${5:-512MB}"

  echo "Deploying $name..."
  gcloud functions deploy "$name" \
    --gen2 \
    --project="$PROJECT" \
    --region="$REGION" \
    --runtime="$RUNTIME" \
    --source="$source_dir" \
    --entry-point="$entry_point" \
    --trigger-http \
    --no-allow-unauthenticated \
    --memory="$memory" \
    --timeout=3600s \
    --set-env-vars="GCP_PROJECT=$PROJECT,SHEETS_DISABLED=1" \
    --service-account="fis-cloud-functions@${PROJECT}.iam.gserviceaccount.com"

  if [ -n "$schedule" ]; then
    echo "  Setting up scheduler: $schedule"
    FUNCTION_URL=$(gcloud functions describe "$name" \
      --gen2 --project="$PROJECT" --region="$REGION" \
      --format="value(serviceConfig.uri)")
    gcloud scheduler jobs create http "fis-$name" \
      --schedule="$schedule" \
      --uri="$FUNCTION_URL" \
      --http-method=POST \
      --location="$REGION" \
      --oidc-service-account-email="fis-cloud-functions@${PROJECT}.iam.gserviceaccount.com" \
      2>/dev/null || \
    gcloud scheduler jobs update http "fis-$name" \
      --schedule="$schedule" \
      --uri="$FUNCTION_URL" \
      --http-method=POST \
      --location="$REGION" \
      --oidc-service-account-email="fis-cloud-functions@${PROJECT}.iam.gserviceaccount.com"
  fi

  echo "  ✅ $name deployed"
}

# Copy shared module into each function's source before deploying
prep_source() {
  local func_dir="$1"
  cp -r backend/shared "$func_dir/"
}

if [ "$TARGET" = "sf_sync" ] || [ "$TARGET" = "all" ]; then
  prep_source "backend/sf_sync"
  deploy_function "fis-sf-sync" "sync_salesforce" "backend/sf_sync" "0 2 * * *" "1GB"
fi

if [ "$TARGET" = "claude_analysis" ] || [ "$TARGET" = "all" ]; then
  prep_source "backend/claude_analysis"
  deploy_function "fis-claude-analysis" "analyze_batch" "backend/claude_analysis" "0 3 * * *" "1GB"
fi

if [ "$TARGET" = "action_engine" ] || [ "$TARGET" = "all" ]; then
  prep_source "backend/action_engine"
  deploy_function "fis-action-engine" "generate_actions" "backend/action_engine" "0 4 * * *" "512MB"
fi

if [ "$TARGET" = "complete_action" ] || [ "$TARGET" = "all" ]; then
  prep_source "backend/complete_action"
  echo "Deploying fis-complete-action (public)..."
  gcloud functions deploy "fis-complete-action" \
    --gen2 \
    --project="$PROJECT" \
    --region="$REGION" \
    --runtime="$RUNTIME" \
    --source="backend/complete_action" \
    --entry-point="complete_action" \
    --trigger-http \
    --allow-unauthenticated \
    --memory="256MB" \
    --timeout=60s \
    --set-env-vars="GCP_PROJECT=$PROJECT,SHEETS_DISABLED=1" \
    --service-account="fis-cloud-functions@${PROJECT}.iam.gserviceaccount.com"
  echo "  ✅ fis-complete-action deployed (public)"
fi

echo ""
echo "=== All functions deployed! ==="
echo ""
echo "Manual triggers:"
echo "  gcloud functions call fis-sf-sync        --region=$REGION --data='{}'"
echo "  gcloud functions call fis-claude-analysis --region=$REGION --data='{}'"
echo "  gcloud functions call fis-action-engine   --region=$REGION --data='{}'"
