.DEFAULT_GOAL := all

.PHONY: all update frontend-update backend-update build frontend-check frontend-build backend-build publish backend-publish backend-publish-build backend-deploy

IMAGE = europe-north2-docker.pkg.dev/altshift-main/images/altshift-tools:latest

# The Cloud Run service the image is deployed to. tools.altshift.se is served by Firebase Hosting,
# which reaches a service over its run.app URL and cannot rewrite to europe-north2, so the service
# runs in europe-north1 while the image stays in the europe-north2 registry. The europe-north2
# service behind the load balancer is gone with the load balancer (altshift_infrastructure 6ea488d),
# and deploying to it would only create it again. Pushing the image does not make Cloud Run take it,
# so the deploy is what moves the public site.
SERVICE = altshift-tools-eun1
REGION = europe-north1


backend-build:
	@echo "[backend] Building..."
	cd backend && go generate && GOOS=linux go build -a -ldflags="-s -w -buildid=" -installsuffix cgo -o ../service

frontend-check:
	@echo "[frontend] Type checking..."
	cd frontend && go tool tsgo --noEmit -p tsconfig.json

frontend-build: frontend-check
	@echo "[frontend] Building..."
	cd frontend && go tool web_build -splitting

build: frontend-build backend-build

backend-update:
	@echo "[backend] Updating..."
	cd backend && gm

frontend-update:
	@echo "[frontend] Updating..."
	cd frontend && ncu --upgrade && npm update

update: frontend-update backend-update

all: update build

backend-publish-build:
	@echo "[backend] Building for publish..."
	cd backend && podman build . --tag altshift-tools

backend-publish: build backend-publish-build
	@echo "[backend] Publishing..."
	podman tag altshift-tools $(IMAGE) && podman push $(IMAGE)

publish: backend-publish

backend-deploy: backend-publish
	@echo "[backend] Deploying $(SERVICE) to $(REGION)..."
	gcloud run deploy $(SERVICE) \
		--image=$(IMAGE) \
		--region=$(REGION) \
		--project=altshift-main \
		--platform=managed \
		--quiet
