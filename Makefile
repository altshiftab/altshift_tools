.DEFAULT_GOAL := all

.PHONY: all update frontend-update backend-update build frontend-check frontend-build backend-build publish backend-publish backend-publish-build backend-deploy

IMAGE = europe-north2-docker.pkg.dev/altshift-main/images/altshift-tools:latest

# The two Cloud Run services the one image is deployed to. tools.altshift.se is served by
# Firebase Hosting, which reaches a service over its run.app URL and cannot rewrite to
# europe-north2 -- so the europe-north1 service is the one visitors actually get, and the
# europe-north2 one behind the load balancer is what it is being moved off. Both answer for
# the name until DNS says otherwise, so both are deployed: pushing the image does not make
# Cloud Run take it, and deploying only the first leaves the public site on the old one.
SERVICES = altshift-tools:europe-north2 altshift-tools-eun1:europe-north1


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
	@echo "[backend] Deploying to Cloud Run..."
	@for service in $(SERVICES); do \
		name=$${service%%:*}; region=$${service##*:}; \
		echo "[backend] Deploying $$name to $$region..."; \
		gcloud run deploy $$name \
			--image=$(IMAGE) \
			--region=$$region \
			--project=altshift-main \
			--platform=managed \
			--quiet || exit 1; \
	done
