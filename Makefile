.DEFAULT_GOAL := all

.PHONY: all update frontend-update backend-update build frontend-build backend-build publish backend-publish backend-publish-build backend-deploy

backend-build:
	@echo "[backend] Building..."
	cd backend && go generate && GOOS=linux go build -a -ldflags="-s -w -buildid=" -installsuffix cgo -o ../service

frontend-build:
	@echo "[frontend] Building..."
	cd frontend && npm run build

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
	cd backend && podman build . --tag altshift-tools-str

backend-publish: build backend-publish-build
	@echo "[backend] Publishing..."
	podman tag altshift-tools-str europe-north2-docker.pkg.dev/altshift-main/images/altshift-tools-str:latest \
		&& podman push europe-north2-docker.pkg.dev/altshift-main/images/altshift-tools-str:latest

publish: backend-publish

backend-deploy: backend-publish
	@echo "[backend] Deploying to Cloud Run..."
	gcloud run deploy altshift-tools-str \
		--image=europe-north2-docker.pkg.dev/altshift-main/images/altshift-tools-str:latest \
		--region=europe-north2 \
		--project=altshift-main \
		--platform=managed \
		--quiet
