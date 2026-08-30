# ADR 0034 — Cloud workspaces start with unrestricted egress

Date: 2026-08-30
Status: Accepted

Cloud workspace account-image forks and prewarmed pools start with unrestricted
outbound internet access, and workspace allocation asserts that open policy on
every fresh, pooled, recovered, and resumed sandbox. Coding agents need stable
access to model APIs, package registries, Git hosts, and arbitrary user-selected
services; a provider-level quarantine can otherwise leave the control plane
reporting a healthy runtime while the agent and desktop connection both fail.

This narrows ADR 0033's quarantine-first rule to forks that inherit a live
machine identity and must re-key before network access. Cloud workspace image
and pool forks are user execution environments and do not use that quarantine
boundary.
