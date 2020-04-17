import * as React from "react"
import {
    SharedLayoutTree,
    Snapshot,
    SharedLayoutProps,
    TransitionHandler,
    AutoAnimationConfig,
} from "../../motion/features/auto/types"
import { SharedLayoutContext } from "../../motion/features/auto/SharedLayoutContext"
import { Auto } from "../../motion/features/auto/Auto"
import { batchTransitions } from "../../motion/features/auto/utils"
import { Easing, circOut, linear } from "@popmotion/easing"
import { progress } from "@popmotion/popcorn"

type MagicStack = Auto[]
type MagicStacks = Map<string, MagicStack>

const defaultMagicTransition = {
    duration: 0.45,
    ease: [0.4, 0, 0.1, 1],
}

interface ChildData {
    shouldResumeFromPrevious?: boolean
    shouldRestoreVisibility?: boolean
    isVisible?: boolean
    snapshot?: Snapshot
}

/**
 * Every render we analyse each child and create a map of data about the
 * following shared layout transition
 */
const childData = new WeakMap<Auto, ChildData>()

function getChildData(child: Auto): ChildData {
    return (childData.get(child) as ChildData) || { isVisible: true }
}

function setChildData(child: Auto, newData: ChildData) {
    const data = getChildData(child)
    childData.set(child, { ...data, ...newData })
}

/**
 * @public
 */
export class AnimateSharedLayout extends React.Component<
    SharedLayoutProps,
    SharedLayoutTree
> {
    /**
     * Keep track of all animate children.
     */
    private children = new Set<Auto>()

    /**
     * As animate components with a defined `layoutId` are added/removed to the tree,
     * we store them in order. When one is added, it will animate out from the
     * previous one, and when it's removed, it'll animate to the previous one.
     */
    private stacks: MagicStacks = new Map()

    /**
     * Keep track of the depth of the most shallow animate child
     * so we can identify root animate children.
     */
    private rootDepth: number

    /**
     * This flag determines whether we re-run snapshots and run animate transitions.
     */
    private shouldTransition: boolean

    /**
     * Create an instance of the update batcher so we can run snapshots across
     * components and fire animate transitions in the correct order.
     */
    private batch = batchTransitions()

    /**
     * We're tracking mount status as only subsequently-entering components need
     * tagging with `shouldResumeFromPrevious`.
     */
    private hasMounted = false

    /**
     * Keep one snapshot for each stack in the event the all layoutId children
     * are removed from a stack before the new one is added.
     */
    private snapshots = new Map<string, Snapshot>()

    state = {
        /**
         * Allow children, like AnimatePresence, to force-render this component
         * to ensure animate children correctly identify parallel state changes that
         * might affect their layout.
         */
        forceRender: (): void => this.setState({ ...this.state }),

        register: (child: Auto) => this.addChild(child),
    }

    componentDidMount() {
        this.hasMounted = true
    }

    /**
     * We always want the component to re-render but for performance reasons we might
     * want to control whether we take snapshots and perform animate transitions.
     */
    shouldComponentUpdate(
        nextProps: SharedLayoutProps,
        nextState: SharedLayoutTree
    ) {
        this.shouldTransition = false

        if (this.state !== nextState) {
            // This should always be true if we've got a new state as a result of a forced render
            this.shouldTransition = true
        } else {
            // If we don't have a defined dependency, or we do and it's changed,
            // we want to transition
            const { dependency } = this.props
            const hasDependency = !!(dependency ?? nextProps.dependency)
            const hasChanged = dependency !== nextProps.dependency

            this.shouldTransition =
                !hasDependency || (hasDependency && hasChanged)
        }

        /**
         * Reset rotation on all children so we can properly measure the correct bounding box.
         * The supportRotate prop isn't public API so this should only run in Framer.
         *
         * Ideally this would run in getSnapshotBeforeUpdate as shouldComponentUpdate may run
         * multiple times in concurrent mode, but currently this is introducing bugs.
         */
        const { supportRotate } = this.props
        supportRotate && this.children.forEach(child => child.resetRotation())

        return true
    }

    /**
     * Loop through all children and update their latest origin snapshots.
     */
    getSnapshotBeforeUpdate() {
        if (!this.shouldTransition) return null

        /**
         * Snapshot the visual origin of every child.
         */
        this.children.forEach(child => child.snapshotOrigin())

        /**
         * Every child keeps a local snapshot, but we also want to record
         * snapshots of the visible children as, if they're are being removed
         * in this render, we can still access them.
         */
        this.stacks.forEach((stack, key) => {
            const latestChild = stack[stack.length - 1]
            latestChild && this.snapshots.set(key, latestChild.measuredOrigin)
        })

        return null
    }

    /**
     * Once all children have updated, snapshot their target snapshots and run
     * animate transitions.
     */
    componentDidUpdate() {
        if (!this.shouldTransition) return

        /**
         * Shared layout animations can be used without the AnimateSharedLayout wrapping component.
         * This requires some co-ordination across components to stop layout thrashing
         * and ensure measurements are taken at the correct time.
         *
         * Here we use that same mechanism of schedule/flush.
         */
        this.children.forEach(child => this.batch.add(child))
        const { type, transition = defaultMagicTransition } = this.props
        const options = { type, transition }
        const handler = controlledHandler(
            options,
            this.rootDepth,
            this.stacks,
            this.snapshots
        )
        this.batch.flush(handler)
        this.snapshots.clear()
    }

    /**
     * Register a new `Magic` child
     */
    addChild(child: Auto) {
        this.setRootDepth(child)
        this.children.add(child)
        this.addChildToStack(child)

        return () => this.removeChild(child)
    }

    addChildToStack(child: Auto) {
        const { layoutId } = child.props
        if (layoutId === undefined) return

        const stack = this.getStack(layoutId)
        stack.push(child)

        this.hasMounted &&
            setChildData(child, { shouldResumeFromPrevious: true })

        const stackLength = stack.length
        if (stackLength > 1) {
            stack.forEach((stackChild, i) => {
                if (i < stackLength - 1) {
                    setChildData(stackChild, { isVisible: false })
                }
            })
        }
    }

    removeChild(child: Auto) {
        this.children.delete(child)
        this.removeChildFromStack(child)
    }

    removeChildFromStack(child: Auto) {
        const { layoutId } = child.props
        if (layoutId === undefined) return

        const stack = this.getStack(layoutId)
        const childIndex = stack.findIndex(stackChild => child === stackChild)
        if (childIndex === -1) return

        stack.splice(childIndex, 1)

        // Set the previous child to visible
        const previousChild = getPreviousChild(stack, stack.length)

        if (previousChild) {
            setChildData(previousChild, {
                isVisible: true,
                shouldRestoreVisibility: true,
            })
        }
    }

    /**
     * Return a stack of animate children based on the provided layoutId.
     * Will create a stack if none currently exists with that layoutId.
     */
    getStack(id: string): MagicStack {
        !this.stacks.has(id) && this.stacks.set(id, [])

        return this.stacks.get(id) as MagicStack
    }

    setRootDepth(child: Auto) {
        this.rootDepth =
            this.rootDepth === undefined
                ? child.depth
                : Math.min(child.depth, this.rootDepth)
    }

    render() {
        return (
            <SharedLayoutContext.Provider value={this.state}>
                {this.props.children}
            </SharedLayoutContext.Provider>
        )
    }
}

function stackQuery<T, F>(
    callback: (layoutId: string, child: Auto) => T | F,
    fallback?: F
) {
    return (child: Auto) => {
        const { layoutId } = child.props
        return layoutId === undefined ? fallback : callback(layoutId, child)
    }
}

function compress(min: number, max: number, easing: Easing): Easing {
    return (p: number) => {
        // Could replace ifs with clamp
        if (p < min) return 0
        if (p > max) return 1
        return easing(progress(min, max, p))
    }
}

function getPreviousChild(stack: MagicStack, index: number) {
    for (let i = index - 1; i >= 0; i--) {
        const child = stack[i]
        if (child.isPresent()) {
            return child
        }
    }

    // If we only have two children, always return the first one
    // even if it isn't present
    if (stack.length === 2) return stack[0]
}

/**
 * TODO: When refactoring this to be a testable pure function that creates a tree
 * of data, allow components to declare themselves "ready" and only play the first
 * frame until then
 */
function controlledHandler(
    { transition, type }: AutoAnimationConfig,
    rootDepth: number,
    stacks: MagicStacks,
    snapshots: Map<string, Snapshot>
): TransitionHandler {
    const visible = new Map<string, Auto>()
    const previous = new Map<string, Auto>()

    stacks.forEach((stack, key) => {
        const visibleIndex = stack.findIndex(
            child => getChildData(child).isVisible
        )
        if (visibleIndex === -1) return

        visible.set(key, stack[visibleIndex])

        const previousChild = getPreviousChild(stack, visibleIndex)
        previousChild && previous.set(key, previousChild)
    })

    const isVisiblePresent = stackQuery(layoutId =>
        visible.get(layoutId)?.isPresent()
    )

    const isVisibleInStack = stackQuery(
        (layoutId, child) => visible.get(layoutId) === child,
        true
    )

    const isPreviousInStack = stackQuery(
        (layoutId, child) => previous.get(layoutId) === child,
        false
    )

    const getVisibleOrigin = stackQuery(
        layoutId => visible.get(layoutId)?.measuredOrigin
    )

    const getVisibleTarget = stackQuery(
        layoutId => visible.get(layoutId)?.measuredTarget
    )

    const isVisibleInStackPresent = stackQuery(layoutId => {
        const visibleInStack = visible.get(layoutId)
        return visibleInStack && visibleInStack.isPresent()
    }, false)

    const isOnlyMemberOfStack = stackQuery(layoutId => {
        const stack = stacks.get(layoutId)
        return !stack ? true : stack.length <= 1
    }, true)

    const getSnapshot = stackQuery(layoutId => snapshots.get(layoutId))

    const isRootChild = (child: Auto) => child.depth === rootDepth

    const getPreviousOrigin = stackQuery(
        (layoutId, child) =>
            previous.get(layoutId)?.measuredOrigin || getSnapshot(child)
    )

    const getPreviousTarget = stackQuery(
        layoutId => previous.get(layoutId)?.measuredTarget
    )

    function crossfadeAnimation(child: Auto) {
        let origin: Snapshot | undefined
        let target: Snapshot | undefined
        let crossfadeEasing: Easing | undefined
        const { shouldResumeFromPrevious } = getChildData(child)

        if (isVisibleInStack(child)) {
            if (child.isPresent() && shouldResumeFromPrevious) {
                // If this component is newly added and entering, animate out from
                // the previous component
                origin = getPreviousOrigin(child)

                if (
                    isRootChild(child) &&
                    !(isOnlyMemberOfStack(child) && getSnapshot(child))
                ) {
                    crossfadeEasing = crossfadeIn
                    origin = opacity(origin || child.measuredTarget, 0)
                }
            } else if (!child.isPresent()) {
                // Or if this child is being removed, animate to the previous component
                target = getPreviousTarget(child)

                if (isRootChild(child)) {
                    crossfadeEasing = crossfadeOut
                    target = opacity(target || child.measuredTarget, 0)
                }
            }
        } else if (isPreviousInStack(child)) {
            if (isVisibleInStackPresent(child)) {
                // If the visible child in this stack is present, animate this component to it
                target = getVisibleTarget(child)

                if (isRootChild(child)) {
                    crossfadeEasing = crossfadeOut
                    target = opacity(target, 0)
                }
            } else {
                // If the visible child in this stack is being removed, animate from it
                origin = getVisibleOrigin(child)

                if (isRootChild(child)) {
                    crossfadeEasing = crossfadeIn
                }
            }
        }

        if (isVisibleInStack(child) || isPreviousInStack(child)) {
            child.startAnimation({
                origin,
                target,
                transition,
                crossfadeEasing,
            })
        } else {
            child.hide()
        }
    }

    function switchAnimation(child: Auto) {
        const {
            isVisible,
            shouldResumeFromPrevious,
            shouldRestoreVisibility,
        } = getChildData(child)

        if (!isVisible) {
            child.hide()
        } else {
            let origin: Snapshot | undefined
            let target: Snapshot | undefined

            if (child.isPresent()) {
                if (shouldResumeFromPrevious) {
                    origin = getPreviousOrigin(child)
                }

                if (shouldRestoreVisibility) {
                    child.show()
                    return
                }
            } else {
                target = getPreviousTarget(child)
            }

            child.startAnimation({ origin, target, transition })
        }
    }

    const animation =
        type === "crossfade" ? crossfadeAnimation : switchAnimation

    return {
        snapshotTarget: child => {
            const { shouldResumeFromPrevious } = getChildData(child)

            if (
                isAutoAnimate(child) ||
                shouldResumeFromPrevious ||
                isVisiblePresent(child)
            ) {
                child.snapshotTarget()
            }
        },
        startAnimation: child => {
            animation(child)
            setChildData(child, {
                shouldResumeFromPrevious: false,
            })
        },
    }
}

const crossfadeIn = compress(0, 0.5, circOut)
const crossfadeOut = compress(0.5, 0.95, linear)

function opacity(snapshot?: Snapshot, value: number = 1) {
    if (!snapshot) return
    return {
        ...snapshot,
        style: {
            ...snapshot.style,
            opacity: value,
        },
    }
}

function isAutoAnimate(child: Auto) {
    return child.props.animate === true
}
