# Native notifications

Upload `spec.yaml` to Mu Data Center as a Spec, allow its slug on your worker
token, and create a Request for pipeline `notify`. Run `mu worker once --config
./mu.yaml` with `WORKER_TOKEN` configured. The Request sends two notifications,
one tagged and one untagged. Requires the companion Data Center string-tag
contract (mu-cli #18/#19).
