# The Helm page's scenario

`landlens-demo` is a small chart (a ConfigMap, a Secret, a Deployment and notes) with dummy development values. Two
revisions give the History tab something to diff:

```bash
helm --kube-context orbstack -n landlens-dev install landlens-demo deploy/scenarios/helm/landlens-demo
helm --kube-context orbstack -n landlens-dev upgrade landlens-demo deploy/scenarios/helm/landlens-demo --set message=hi --set replicaCount=2
```

`helm --kube-context orbstack -n landlens-dev uninstall landlens-demo` removes it.
