.DEFAULT_GOAL := all

.PHONY: all update frontend-update backend-update build check test test-wasm frontend-check frontend-test frontend-build backend-build backend-test http-headers-wasm http-headers-worker http-headers-assets publish backend-publish backend-publish-build backend-deploy guard-release-versions

IMAGE = europe-north2-docker.pkg.dev/altshift-main/images/altshift-tools:latest

# The Cloud Run service the image is deployed to. tools.altshift.se is served by Firebase Hosting,
# which reaches a service over its run.app URL and cannot rewrite to europe-north2, so the service
# runs in europe-north1 while the image stays in the europe-north2 registry. The europe-north2
# service behind the load balancer is gone with the load balancer (altshift_infrastructure 6ea488d),
# and deploying to it would only create it again. Pushing the image does not make Cloud Run take it,
# so the deploy is what moves the public site.
SERVICE = altshift-tools-eun1
REGION = europe-north1

GOROOT_WASM := $(shell go env GOROOT)/lib/wasm
HTTP_HEADERS_ASSETS := backend/http_headers_assets

# The /http-headers analysis, compiled to WebAssembly so that what is pasted is analysed in the
# browser. It is built with the standard toolchain: TinyGo cannot build it, its standard library
# lacking the net/http/cookiejar that utils_go's public suffix list imports. It carries no VCS
# stamp, which would hand every visitor the revision and whether the tree was dirty, and would make
# the backend that embeds it differ between a clean and a dirty build of one commit.
http-headers-wasm:
	@echo "[http-headers] Building the WebAssembly module..."
	mkdir -p $(HTTP_HEADERS_ASSETS)
	GOOS=js GOARCH=wasm go build -trimpath -buildvcs=false -ldflags="-s -w" -o $(HTTP_HEADERS_ASSETS)/http_headers.wasm ./cmd/http_headers_wasm
	cp "$(GOROOT_WASM)/wasm_exec.js" $(HTTP_HEADERS_ASSETS)/

http-headers-worker:
	@echo "[http-headers] Building the worker..."
	cd frontend && go tool tsgo -p tsconfig.worker.json

# Each asset is compressed here rather than when the service starts, which for the module takes
# seconds of every instance's start at the best brotli quality. Needs brotli and gzip.
http-headers-assets: http-headers-wasm http-headers-worker
	@echo "[http-headers] Compressing..."
	for asset in worker.js wasm_exec.js http_headers.wasm; do \
		file=$(HTTP_HEADERS_ASSETS)/$$asset; \
		brotli --force --best --output=$$file.br $$file && gzip --best --no-name --force --keep $$file || exit 1; \
	done

backend-build: http-headers-assets
	@echo "[backend] Building..."
	cd backend && go generate && GOOS=linux go build -a -ldflags="-s -w -buildid=" -installsuffix cgo -o ../service

# The backend embeds the built frontend and analysis assets, so its tests run after a build.
backend-test: backend-build
	cd backend && go test -race ./...

test:
	go test ./...

# The bridge's tests, under js/wasm in Node, where syscall/js is real. The environment is cleared
# because the runtime hands all of it to the module, which refuses more than a few kilobytes.
test-wasm:
	env -i PATH="$$PATH" HOME="$$HOME" GOPATH="$$(go env GOPATH)" GOMODCACHE="$$(go env GOMODCACHE)" GOCACHE="$$(go env GOCACHE)" \
		GOPRIVATE="$$(go env GOPRIVATE)" GOOS=js GOARCH=wasm go test -exec "$(GOROOT_WASM)/go_js_wasm_exec" ./cmd/http_headers_wasm ./pkg/...

frontend-test: frontend-check
	cd frontend && npm test

check: test test-wasm frontend-test backend-test

frontend-check:
	@echo "[frontend] Type checking..."
	cd frontend && go tool tsgo --noEmit -p tsconfig.json && go tool tsgo --noEmit -p tsconfig.test.json

frontend-build: frontend-check
	@echo "[frontend] Building..."
	cd frontend && go tool web_build --splitting

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

# What is published is built from releases of my modules, never from a commit under test (a
# pseudo-version): https://wiki.vvvp.se/?page=go-module-versions. GOWORK=off reads the module graph the
# image is built from, and a failing go list fails the guard rather than passing it.
guard-release-versions:
	@for dir in backend .; do (cd $$dir && modules=$$(GOWORK=off go list -m -f '{{.Path}} {{.Version}}' all) && \
	test_versions=$$(printf '%s\n' "$$modules" | grep -E '^github\.com/(Motmedel|altshiftab|vphpersson|intilgroup)/[^ ]* v[^ ]*[0-9]{14}-[0-9a-f]{12}$$' || true) && \
	if [ -n "$$test_versions" ]; then printf '[deploy] Built from test versions of my modules; release them first:\n%s\n' "$$test_versions" >&2; exit 1; fi) || exit 1; done

backend-publish: guard-release-versions build backend-publish-build
	@echo "[backend] Publishing..."
	podman tag altshift-tools $(IMAGE) && podman push $(IMAGE)

publish: backend-publish

backend-deploy: guard-release-versions backend-publish
	@echo "[backend] Deploying $(SERVICE) to $(REGION)..."
	gcloud run deploy $(SERVICE) \
		--image=$(IMAGE) \
		--region=$(REGION) \
		--project=altshift-main \
		--platform=managed \
		--quiet
